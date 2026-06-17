/**
 * Database schema definition for NLQ (Natural Language to SQL) service.
 * This schema is sent to Claude as context for generating SQL queries.
 */

const DB_SCHEMA = `
-- PostgreSQL Database Schema for Truckast (Concrete Delivery Management System)
-- This schema describes all tables, columns, types, constraints, and relationships.

-- =============================================
-- CORE BUSINESS TABLES
-- =============================================

-- Orders: Central table for concrete delivery orders
CREATE TABLE public.orders (
  order_id bigint PRIMARY KEY,
  created_date timestamptz NOT NULL,
  order_date timestamptz NOT NULL,
  update_time timestamptz NOT NULL,
  order_code text NOT NULL,
  order_type integer NOT NULL,
  order_type_description text NOT NULL,
  customer_id bigint NOT NULL,
  customer_code text NOT NULL,
  customer_name text NOT NULL,
  customer_job text,
  payment_form integer,
  project_id bigint,
  project_code text,
  project_name text,
  lot_block_number text,
  purchase_order text,
  job_number text,
  delivery_addr1 text,
  delivery_addr2 text,
  delivery_addr3 text,
  instruction_addr1 text, instruction_addr2 text, instruction_addr3 text,
  instruction_addr4 text, instruction_addr5 text, instruction_addr6 text,
  map_page text,
  zone_code text,
  zone_name text,
  current_status integer NOT NULL, -- 0=Normal, 1=Will Call, 2=Weather Permitting, 3=Hold Delivery, 4=Completed, 5=Wait List
  removed boolean,
  remove_reason_code text,
  hauler_code text, hauler_name text,
  price_category_code text, price_category_name text,
  pricing_plant_code text,
  tax_code text NOT NULL, taxable boolean NOT NULL,
  non_taxable_reason_code text, non_taxable_reason_short_description text,
  taken_by_employee_id text, taken_by_employee_code text,
  taken_on_extension text,
  ordered_by_name text, ordered_by_phone text,
  recipient_email text, pocket_number text,
  salesman_id text, salesman_code text, salesman_name text,
  sales_analysis_code text,
  trade_discount_percent numeric, trade_discount_amount numeric,
  grand_total_amount numeric,
  is_suspended boolean, suspend_reason_code text, suspend_short_description text,
  credit_override_user text,
  latitude text, longitude text,
  usage_code text, usage_short text,
  removed_by text, building_permit text, confirmed_by text,
  jobsite_radius integer, reviewed boolean,
  payment_amount numeric, check_number text,
  credit_card_last_four_digits text, credit_card_expiration_date text,
  credit_card_authorization_code text, bank_account text,
  pre_delivery_reminder_at timestamptz,
  payload_hash text,
  weather_data jsonb,
  confirmation_channel varchar
);
-- Status codes: 0=Normal, 1=Will Call, 2=Weather Permitting (excluded), 3=Hold Delivery, 4=Completed, 5=Wait List
-- Cancelled = removed=true AND remove_reason_code IS NOT NULL AND TRIM(remove_reason_code) <> ''

-- Order Products: Products/mixes within an order
CREATE TABLE public.order_products (
  id bigint PRIMARY KEY,
  order_id bigint REFERENCES orders(order_id),
  product_id bigint, item_id bigint,
  item_code text NOT NULL,
  description text NOT NULL, short_description text NOT NULL,
  is_mix boolean NOT NULL, is_assoc boolean NOT NULL,
  price numeric NOT NULL, price_unit text NOT NULL,
  order_qty numeric NOT NULL, order_qty_unit text NOT NULL,
  load_qty numeric NOT NULL,
  delv_qty numeric NOT NULL, delv_qty_unit text NOT NULL,
  slump text, trim_percent numeric,
  comments text,
  usage_code text, usage_name text,
  taxable boolean NOT NULL, trade_discountable boolean NOT NULL
);

-- Order Product Schedules: Scheduling details per product
CREATE TABLE public.order_product_schedules (
  id bigint PRIMARY KEY,
  order_product_id bigint REFERENCES order_products(id),
  product_schedule_id bigint NOT NULL,
  plant_id bigint NOT NULL, plant_code text NOT NULL,
  start_time timestamptz NOT NULL,
  schedule_qty numeric NOT NULL, schedule_delv_qty numeric NOT NULL, hold_qty numeric NOT NULL,
  truck_type_id bigint NOT NULL, truck_type_code text NOT NULL, truck_type_name text NOT NULL,
  load_qty numeric NOT NULL,
  job_wash_time integer NOT NULL,
  pouring_method_code text, pouring_method_short text,
  unload_rate_per_hour numeric, distance numeric,
  time_to_job integer NOT NULL, time_to_plant integer,
  truck_space integer, unload_time integer NOT NULL,
  delivery_rate_per_hour numeric NOT NULL, trucks_required numeric NOT NULL,
  number_of_loads integer NOT NULL
);

-- Schedule Loads: Individual truck loads
CREATE TABLE public.order_product_schedule_loads (
  id bigint PRIMARY KEY,
  order_product_schedule_id bigint REFERENCES order_product_schedules(id),
  schedule_load_id bigint NOT NULL,
  from_plant_id bigint NOT NULL, from_plant text NOT NULL,
  load_qty numeric NOT NULL,
  truck_id bigint, truck_code text,
  to_plant_id bigint NOT NULL, to_plant text NOT NULL,
  time_to_job integer NOT NULL, unload_time integer, time_to_plant integer,
  truck_space integer,
  printed_time timestamptz, load_time timestamptz,
  on_job_time timestamptz, fin_pour_time timestamptz, at_plant_time timestamptz,
  time_to_wash integer,
  ticket_id bigint, ticket_code text
);

-- Order Notes
CREATE TABLE public.order_notes (
  id bigint PRIMARY KEY,
  order_id bigint REFERENCES orders(order_id),
  note_id bigint,
  note_description text NOT NULL,
  note_date timestamptz NOT NULL
);

-- =============================================
-- CUSTOMERS & PROJECTS
-- =============================================

CREATE TABLE public.customers (
  id bigint PRIMARY KEY,
  code text NOT NULL, name text NOT NULL,
  setup_date timestamptz, sort_name text,
  contact text, phone text, fax text, cellular text, email text,
  salesman_code text, salesman_name text,
  tax_code text, taxable boolean,
  price_category_code text, price_category_name text,
  zone_code text,
  division_id bigint NOT NULL, division_code text NOT NULL,
  inactive boolean,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.customer_contacts (
  id bigint PRIMARY KEY,
  customer_id bigint REFERENCES customers(id),
  contact_type text, is_primary boolean DEFAULT false,
  contact_name text NOT NULL, job_title text, department text,
  phone text, cellular text, email text,
  active boolean DEFAULT true
);

CREATE TABLE public.projects (
  id bigint PRIMARY KEY,
  code text NOT NULL, name text NOT NULL,
  customer_id bigint NOT NULL, customer_code text NOT NULL, customer_name text NOT NULL,
  setup_date timestamptz,
  delivery_addr1 text, delivery_addr2 text, delivery_addr3 text,
  contact text, phone text, email text,
  zone_code text,
  latitude numeric, longitude numeric,
  update_date timestamptz
);

CREATE TABLE public.jobs (
  id bigint PRIMARY KEY,
  code text NOT NULL, name text NOT NULL,
  customer_id bigint NOT NULL, customer_code text NOT NULL, customer_name text NOT NULL,
  delivery_addr1 text, delivery_addr2 text, delivery_addr3 text,
  contact text, phone text, email text,
  zone_code text,
  update_date timestamp
);

-- =============================================
-- PLANTS & LOCATIONS
-- =============================================

CREATE TABLE public.plants (
  id bigint PRIMARY KEY,
  code text NOT NULL UNIQUE,
  description text, short_description text,
  address1 text, address2 text, address3 text, phone text,
  location_id bigint NOT NULL, location_code text NOT NULL,
  company_id bigint NOT NULL, company_code text NOT NULL,
  windows_time_zone text NOT NULL, iana_time_zone text NOT NULL,
  latitude text, longitude text,
  region_id bigint REFERENCES regions(id)
);

CREATE TABLE public.locations (
  id bigint PRIMARY KEY,
  code bigint NOT NULL, name text NOT NULL,
  company_id bigint, company_code bigint
);

CREATE TABLE public.regions (
  id bigint PRIMARY KEY,
  code text NOT NULL UNIQUE,
  description text
);

-- =============================================
-- TICKETS (Delivery Tickets)
-- =============================================

CREATE TABLE public.tickets (
  id bigint PRIMARY KEY,
  ticket_id bigint NOT NULL UNIQUE,
  created_date timestamptz NOT NULL,
  plant_id bigint NOT NULL, plant_code text NOT NULL, plant_name text,
  location_id bigint NOT NULL, location_code text NOT NULL, location_name text NOT NULL,
  ticket_code text NOT NULL,
  order_date timestamptz NOT NULL,
  order_id bigint NOT NULL, order_code text NOT NULL,
  current_status integer NOT NULL, order_current_status integer NOT NULL,
  truck_code text, driver_code text, driver_name text,
  customer_id bigint NOT NULL, customer_code text NOT NULL, customer_name text NOT NULL,
  project_id bigint, project_code text, project_name text,
  delivery_addr1 text, delivery_addr2 text, delivery_addr3 text,
  zone_code text, zone_name text,
  usage_code text, usage_short text,
  scheduled_on_job_time timestamptz,
  printed_time timestamptz, load_time timestamptz, loaded_time timestamptz,
  to_job_time timestamptz, on_job_time timestamptz,
  unload_time timestamptz, end_unload timestamptz,
  wash_time timestamptz, to_plant_time timestamptz, at_plant_time timestamptz,
  active boolean NOT NULL,
  amount numeric, total_amount numeric, tax_amount numeric,
  removed boolean,
  update_time timestamptz
);

CREATE TABLE public.ticket_products (
  id bigint PRIMARY KEY,
  ticket_id bigint REFERENCES tickets(ticket_id),
  item_code text NOT NULL, description text, short_description text,
  is_mix boolean NOT NULL, is_assoc boolean NOT NULL,
  price numeric, price_unit text,
  order_qty numeric, order_qty_unit text,
  load_qty numeric, delv_qty numeric, delv_qty_unit text,
  acc_delv_qty numeric, ticket_qty numeric, ticket_qty_unit text,
  slump numeric
);

-- =============================================
-- TRUCKS & GPS
-- =============================================

CREATE TABLE public.trucks (
  id bigint PRIMARY KEY,
  code text NOT NULL,
  description text, short_description text,
  active boolean,
  plant_id text, plant_code text, plant_name text,
  driver_id text, driver_code text, driver_name text,
  current_plant_id bigint, current_plant_code text, current_plant_name text,
  current_driver_id bigint, current_driver_code text, current_driver_name text,
  truck_type_id bigint, truck_type_code text, truck_type_name text,
  latitude text, longitude text,
  status_code text, status_timestamp timestamptz
);

CREATE TABLE public.truck_statuses (
  id bigint PRIMARY KEY,
  code text NOT NULL,
  current_plant_id bigint, current_plant_code text, current_plant_name text,
  current_driver_id bigint, current_driver_code text, current_driver_name text,
  latitude text, longitude text,
  status_code text, status_timestamp timestamp,
  ticket_id bigint
);

CREATE TABLE public.truck_gps_updates (
  id bigint PRIMARY KEY,
  signaling_unit_code text NOT NULL, truck_code text NOT NULL,
  latitude text, longitude text, speed text, heading text,
  gps_timestamp timestamp
);

-- =============================================
-- USERS & ROLES
-- =============================================

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  full_name text, active boolean DEFAULT false,
  title text, phone_number text,
  last_login_at timestamptz
);

CREATE TABLE public.roles (
  id bigint PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  role_type text NOT NULL DEFAULT 'custom', -- data, application, report, custom, region_role, plant_role, mixed_role
  code text
);

CREATE TABLE public.user_roles (
  id bigint PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  role_id bigint REFERENCES roles(id)
);

CREATE TABLE public.user_customers (
  id bigint PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  customer_id bigint REFERENCES customers(id)
);

-- =============================================
-- PRODUCTS & ITEMS
-- =============================================

CREATE TABLE public.items (
  id bigint PRIMARY KEY,
  code text NOT NULL,
  description text, short_description text,
  category_code text, item_type text,
  is_constituent boolean DEFAULT false,
  strength integer, slump numeric,
  setup_date timestamptz, update_date timestamptz
);

CREATE TABLE public.item_categories (
  id bigint PRIMARY KEY,
  name text, description text,
  item_type_id bigint NOT NULL, item_type text NOT NULL
);

-- =============================================
-- NOTIFICATIONS & ALERTS
-- =============================================

CREATE TABLE public.order_alerts (
  id bigint PRIMARY KEY,
  alert_type varchar NOT NULL,
  order_id integer NOT NULL, order_code varchar NOT NULL,
  order_date date NOT NULL,
  customer_name varchar, plant_code varchar,
  status varchar NOT NULL DEFAULT 'pending',
  alert_reason varchar,
  email_sent boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.announcements (
  id bigint PRIMARY KEY,
  name varchar NOT NULL, campaign varchar NOT NULL,
  start_date timestamptz, end_date timestamptz,
  title varchar, subtitle varchar,
  published boolean DEFAULT false,
  plant_ids bigint[] DEFAULT '{}'
);

-- =============================================
-- COMPANIES & DIVISIONS
-- =============================================

CREATE TABLE public.companies (
  id bigint PRIMARY KEY,
  code text NOT NULL, short text NOT NULL, name text NOT NULL,
  phone text, email text
);

CREATE TABLE public.divisions (
  id bigint PRIMARY KEY,
  code text NOT NULL, name text NOT NULL,
  parent_id bigint, hierarchy_id text NOT NULL
);

CREATE TABLE public.employees (
  id bigint PRIMARY KEY,
  code text NOT NULL, name text,
  active boolean, employee_type text,
  plant_id bigint, plant_code text,
  email text
);

-- =============================================
-- WEATHER & INTELLIGENCE
-- =============================================

CREATE TABLE public.plant_weather (
  id bigint PRIMARY KEY,
  plant_id bigint NOT NULL UNIQUE REFERENCES plants(id),
  latitude numeric, longitude numeric,
  temperature_fahrenheit numeric,
  weather_condition text, weather_description text,
  humidity integer, wind_speed numeric,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.daily_intelligence (
  id bigint PRIMARY KEY,
  report_date date NOT NULL,
  plant_code text, region_name text,
  late_orders_total integer DEFAULT 0,
  stuck_at_job_total integer DEFAULT 0,
  slow_plants_total integer DEFAULT 0,
  weather_risk_total integer DEFAULT 0,
  status_pre_pour integer DEFAULT 0,
  status_in_process integer DEFAULT 0,
  status_completed integer DEFAULT 0,
  status_canceled integer DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================
-- EXCLUDED PATTERNS (for filtering orders)
-- =============================================

CREATE TABLE public.excluded_order_patterns (
  id bigint PRIMARY KEY,
  type text NOT NULL, -- 'product', 'customer', 'delivery_address'
  pattern text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true
);

-- =============================================
-- ORDER CHANGE TRACKING
-- =============================================

CREATE TABLE public.order_change_logs (
  id bigint PRIMARY KEY,
  order_id bigint REFERENCES orders(order_id),
  order_code text NOT NULL,
  order_date timestamptz NOT NULL,
  table_name text NOT NULL, -- 'orders', 'order_products', 'order_product_schedules'
  field_name text NOT NULL,
  old_value text, new_value text,
  change_message text NOT NULL,
  change_type text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- =============================================
-- CHAT SYSTEM
-- =============================================

CREATE TABLE public.order_chats (
  id bigint PRIMARY KEY,
  order_id bigint NOT NULL UNIQUE,
  last_message_at timestamptz, is_active boolean DEFAULT true
);

CREATE TABLE public.chat_messages (
  id bigint PRIMARY KEY,
  chat_id bigint REFERENCES order_chats(id),
  order_id bigint NOT NULL,
  sender_id uuid NOT NULL, sender_name text NOT NULL,
  sender_role text NOT NULL, -- 'concrete_producer', 'contractor', 'admin'
  message_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_deleted boolean DEFAULT false
);

-- =============================================
-- KEY RELATIONSHIPS SUMMARY
-- =============================================
-- orders -> order_products (order_id)
-- order_products -> order_product_schedules (order_product_id)
-- order_product_schedules -> order_product_schedule_loads (order_product_schedule_id)
-- orders -> tickets (order_id)
-- tickets -> ticket_products (ticket_id)
-- orders -> order_notes (order_id)
-- orders -> order_change_logs (order_id)
-- customers -> orders (customer_id)
-- customers -> projects (customer_id)
-- projects -> orders (project_id)
-- plants -> order_product_schedules (plant_id)
-- plants -> tickets (plant_id)
-- users -> user_roles -> roles
-- users -> user_customers -> customers
-- plants -> regions (region_id)
-- plants -> plant_weather (plant_id)
`;

module.exports = { DB_SCHEMA };
