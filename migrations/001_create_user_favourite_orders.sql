-- Migration: Create user_favourite_orders table
-- Description: Stores user favourite orders for quick access
-- Date: 2026-02-05

-- NOTE: order_id is VARCHAR to match public.orders.order_id (a varchar UUID in
-- this tenant's DB). Do not use BIGINT — that was the Stevenson Weir schema.
CREATE TABLE IF NOT EXISTS user_favourite_orders (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL,
    order_id VARCHAR NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Unique constraint: a user can only favourite an order once
ALTER TABLE user_favourite_orders
    ADD CONSTRAINT uq_user_favourite_order UNIQUE (user_id, order_id);

-- Index for fast lookup by user_id (get all favourites for a user)
CREATE INDEX IF NOT EXISTS idx_user_favourite_orders_user_id
    ON user_favourite_orders (user_id);

-- Index for fast lookup by order_id (check if an order is favourited)
CREATE INDEX IF NOT EXISTS idx_user_favourite_orders_order_id
    ON user_favourite_orders (order_id);
