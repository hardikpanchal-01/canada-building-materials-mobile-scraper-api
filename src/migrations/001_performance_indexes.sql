-- Performance indexes for TruckAst API
-- Run this against the PostgreSQL database to improve query performance.
--
-- These indexes target the most frequently used WHERE, JOIN, and ORDER BY columns
-- across all API queries (orders, tickets, schedules, etc.)

-- ============================================================================
-- Orders table
-- ============================================================================

-- Primary filter: all order queries filter by order_date range
CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders (order_date);

-- Lookup by order_code + order_date (getOrderByCodeAndDate, detail views)
CREATE INDEX IF NOT EXISTS idx_orders_code_date ON orders (order_code, order_date);

-- Access control: contractor filter by customer_id
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders (customer_id);

-- Pricing plant code (used in company/region/plant filters via JOIN to plants)
CREATE INDEX IF NOT EXISTS idx_orders_pricing_plant_code ON orders (pricing_plant_code);

-- Customer name ILIKE for exclusion patterns and search
CREATE INDEX IF NOT EXISTS idx_orders_customer_name_lower ON orders (LOWER(customer_name));

-- ============================================================================
-- Order Products table
-- ============================================================================

-- Core JOIN: order_products.order_id (with CY/mix filter)
CREATE INDEX IF NOT EXISTS idx_order_products_order_id ON order_products (order_id);

-- Composite for the common filter pattern: order_id + CY + is_mix
CREATE INDEX IF NOT EXISTS idx_order_products_order_mix ON order_products (order_id)
  WHERE order_qty_unit = 'YDQ' AND is_mix = true;

-- Exclusion pattern check: item_code ILIKE
CREATE INDEX IF NOT EXISTS idx_order_products_item_code ON order_products (order_id, item_code);

-- ============================================================================
-- Order Product Schedules table
-- ============================================================================

-- JOIN from order_products
CREATE INDEX IF NOT EXISTS idx_ops_order_product_id ON order_product_schedules (order_product_id);

-- Plant code filter (access control + plant filter)
CREATE INDEX IF NOT EXISTS idx_ops_plant_code ON order_product_schedules (plant_code);

-- Start time ordering
CREATE INDEX IF NOT EXISTS idx_ops_start_time ON order_product_schedules (start_time);

-- ============================================================================
-- Order Product Schedule Loads table
-- ============================================================================

-- JOIN from schedules
CREATE INDEX IF NOT EXISTS idx_opsl_schedule_id ON order_product_schedule_loads (order_product_schedule_id);

-- Ticket lookup
CREATE INDEX IF NOT EXISTS idx_opsl_ticket_code ON order_product_schedule_loads (ticket_code);

-- ============================================================================
-- Tickets table
-- ============================================================================

-- Most common JOIN: tickets.order_id
CREATE INDEX IF NOT EXISTS idx_tickets_order_id ON tickets (order_id);

-- Ticket code lookup (used in schedule loads JOIN)
CREATE INDEX IF NOT EXISTS idx_tickets_ticket_code ON tickets (ticket_code);

-- Composite: order_id + non-cancelled filter (very frequent)
CREATE INDEX IF NOT EXISTS idx_tickets_order_active ON tickets (order_id)
  WHERE remove_reason_code IS NULL OR TRIM(remove_reason_code) = '';

-- created_date for sorting (DISTINCT ON, ORDER BY)
CREATE INDEX IF NOT EXISTS idx_tickets_order_created ON tickets (order_id, created_date DESC NULLS LAST);

-- Truck code (for truck lookups)
CREATE INDEX IF NOT EXISTS idx_tickets_truck_code ON tickets (truck_code);

-- ============================================================================
-- Ticket Products table
-- ============================================================================

-- JOIN from tickets (with mix filter)
CREATE INDEX IF NOT EXISTS idx_ticket_products_ticket_mix ON ticket_products (ticket_id)
  WHERE is_mix = true;

-- ============================================================================
-- Order Notes table
-- ============================================================================

-- JOIN from orders
CREATE INDEX IF NOT EXISTS idx_order_notes_order_id ON order_notes (order_id);

-- ============================================================================
-- Order Change Logs table
-- ============================================================================

-- Detail view: order_id + ordering
CREATE INDEX IF NOT EXISTS idx_order_change_logs_order ON order_change_logs (order_id, changed_at DESC, id DESC);

-- ============================================================================
-- Archive Orders table
-- ============================================================================

-- Snapshot lookup
CREATE INDEX IF NOT EXISTS idx_archive_orders_order_id ON archive_orders (order_id, archived_at ASC);

-- ============================================================================
-- Plants table
-- ============================================================================

-- JOIN from orders.pricing_plant_code
CREATE INDEX IF NOT EXISTS idx_plants_code ON plants (code);

-- ============================================================================
-- Trucks table
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_trucks_code ON trucks (code);

-- ============================================================================
-- Employees table
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_employees_code ON employees (code);

-- ============================================================================
-- Exclusion Patterns table
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_excluded_patterns_active ON excluded_order_patterns (active) WHERE active = true;

-- ============================================================================
-- Additional composite indexes (Phase 2 - query pattern optimization)
-- ============================================================================

-- Tickets: DISTINCT ON (truck_code) ORDER BY created_date DESC (truckService)
CREATE INDEX IF NOT EXISTS idx_tickets_truck_created ON tickets (truck_code, created_date DESC NULLS LAST);

-- Tickets: ticket_code + order_id composite for schedule loads JOIN
CREATE INDEX IF NOT EXISTS idx_tickets_code_order ON tickets (ticket_code, order_id);

-- Ticket Products: covering index for the common LATERAL pattern (ticket_id + is_mix + load_qty)
CREATE INDEX IF NOT EXISTS idx_ticket_products_ticket_mix_cover ON ticket_products (ticket_id, is_mix, load_qty)
  WHERE is_mix = true;

-- Orders: composite for date range + status filtering (getOrders CTE)
CREATE INDEX IF NOT EXISTS idx_orders_date_status ON orders (order_date, current_status);

-- Orders: delivery address search (ILIKE on addr1)
CREATE INDEX IF NOT EXISTS idx_orders_delivery_addr1_lower ON orders (LOWER(delivery_addr1));

-- Order Product Schedules: composite for product JOIN + start_time sort
CREATE INDEX IF NOT EXISTS idx_ops_product_start ON order_product_schedules (order_product_id, start_time ASC);

-- Regions: JOIN from plants for zone-based access control
CREATE INDEX IF NOT EXISTS idx_regions_description ON regions (description);

-- Plants: region_id for zone-based access control JOIN
CREATE INDEX IF NOT EXISTS idx_plants_region_id ON plants (region_id);

-- Plants: company_code for company filter JOIN
CREATE INDEX IF NOT EXISTS idx_plants_company_code ON plants (company_code);
