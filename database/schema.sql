-- Circle Member App Database Schema
-- This file contains the complete database schema for the Circle Member App
-- It includes the base schema and all subsequent migrations.
-- Run this after starting the PostgreSQL container to initialize the database.

-- Enable useful extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table 1: Members (Core User Table)
-- Stores essential member information synchronized from Circle API
CREATE TABLE IF NOT EXISTS members (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    circle_member_id BIGINT NOT NULL UNIQUE, -- Foreign key to Circle's system
    circle_user_id BIGINT,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255),
    avatar_url TEXT,
    is_admin BOOLEAN DEFAULT FALSE,
    is_moderator BOOLEAN DEFAULT FALSE,
    is_paid BOOLEAN DEFAULT FALSE, -- Determined by tags or Circle API data
    tags JSONB, -- Store the member_tags array here
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 2: Member Credits (Credit System)
-- Separates credit logic for flexibility and complex operations
CREATE TABLE IF NOT EXISTS member_credits (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    member_id BIGINT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
    credits_balance INT NOT NULL DEFAULT 0,
    last_refreshed_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 3: App Actions (Activity Log)
-- Generic table to log actions users take that consume credits
CREATE TABLE IF NOT EXISTS app_actions (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL, -- e.g., 'generate_image', 'send_message', 'api_call'
    credits_cost INT NOT NULL DEFAULT 1,
    metadata JSONB, -- Store prompts, URLs, message content, etc.
    success BOOLEAN DEFAULT TRUE, -- Whether the action succeeded
    error_message TEXT, -- Store error details if action failed
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 4: Credit History (Audit Trail)
-- Track all credit changes for transparency and debugging
CREATE TABLE IF NOT EXISTS credit_history (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    change_amount INT NOT NULL, -- Positive for credits added, negative for credits spent
    change_type VARCHAR(50) NOT NULL, -- 'initial_grant', 'monthly_refresh', 'action_cost', 'manual_adjustment', 'purchase'
    balance_after INT NOT NULL, -- Balance after this change
    reference_id BIGINT, -- Reference to app_actions.id if related to an action
    notes TEXT, -- Additional context
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table 5: Processed Purchase Tags (Audit Log for Purchases)
-- This table tracks one-time purchase tags that grant credits. It's an audit log.
CREATE TABLE IF NOT EXISTS processed_purchase_tags (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    member_id BIGINT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    tag_value VARCHAR(100) NOT NULL, -- The tag like "$10", "$50", "100"
    credits_granted INT NOT NULL, -- Number of credits granted for this tag
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_members_circle_member_id ON members(circle_member_id);
CREATE INDEX IF NOT EXISTS idx_members_email ON members(email);
CREATE INDEX IF NOT EXISTS idx_members_last_seen ON members(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_member_credits_member_id ON member_credits(member_id);
CREATE INDEX IF NOT EXISTS idx_member_credits_last_refreshed ON member_credits(last_refreshed_at);
CREATE INDEX IF NOT EXISTS idx_app_actions_member_id ON app_actions(member_id);
CREATE INDEX IF NOT EXISTS idx_app_actions_created_at ON app_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_app_actions_action_type ON app_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_credit_history_member_id ON credit_history(member_id);
CREATE INDEX IF NOT EXISTS idx_credit_history_created_at ON credit_history(created_at);
CREATE INDEX IF NOT EXISTS idx_processed_tags_member_tag ON processed_purchase_tags(member_id, tag_value);
CREATE INDEX IF NOT EXISTS idx_processed_purchase_tags_processed_at ON processed_purchase_tags(processed_at);

-- Function to automatically update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to automatically update updated_at
CREATE TRIGGER update_members_updated_at BEFORE UPDATE ON members FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_member_credits_updated_at BEFORE UPDATE ON member_credits FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to log credit changes (Note: The app logic in server.js handles this manually now for better context)
-- The trigger below is kept as a fallback/safety net.
CREATE OR REPLACE FUNCTION log_credit_change()
RETURNS TRIGGER AS $$
BEGIN
    -- Only log if credits_balance actually changed
    IF (TG_OP = 'UPDATE' AND OLD.credits_balance != NEW.credits_balance) THEN
        INSERT INTO credit_history (member_id, change_amount, change_type, balance_after, notes)
        VALUES (
            NEW.member_id,
            NEW.credits_balance - OLD.credits_balance,
            CASE 
                WHEN NEW.credits_balance > OLD.credits_balance THEN 'credit_addition'
                ELSE 'credit_deduction'
            END,
            NEW.credits_balance,
            'Automatic log from credit balance change'
        );
    ELSIF (TG_OP = 'INSERT') THEN
        INSERT INTO credit_history (member_id, change_amount, change_type, balance_after, notes)
        VALUES (
            NEW.member_id,
            NEW.credits_balance,
            'initial_grant',
            NEW.credits_balance,
            'Initial credit grant for new member'
        );
    END IF;
    
    RETURN COALESCE(NEW, OLD);
END;
$$ language 'plpgsql';

-- Trigger to automatically log credit changes
CREATE TRIGGER log_member_credits_changes 
    AFTER INSERT OR UPDATE ON member_credits 
    FOR EACH ROW EXECUTE FUNCTION log_credit_change();

-- View for member summary (convenient for queries)
CREATE OR REPLACE VIEW member_summary AS
SELECT 
    m.id,
    m.circle_member_id,
    m.email,
    m.name,
    m.avatar_url,
    m.is_admin,
    m.is_moderator,
    m.is_paid,
    m.tags,
    m.first_seen_at,
    m.last_seen_at,
    COALESCE(mc.credits_balance, 0) as credits_balance,
    mc.last_refreshed_at as credits_last_refreshed,
    (SELECT COUNT(*) FROM app_actions WHERE member_id = m.id) as total_actions,
    (SELECT COALESCE(SUM(credits_cost), 0) FROM app_actions WHERE member_id = m.id AND success = true) as total_credits_spent
FROM members m
LEFT JOIN member_credits mc ON m.id = mc.member_id;

-- Comments for tables and views
COMMENT ON TABLE members IS 'Core member data synchronized from Circle API';
COMMENT ON TABLE member_credits IS 'Credit balance and refresh tracking for each member';
COMMENT ON TABLE app_actions IS 'Log of all actions taken by members that may consume credits';
COMMENT ON TABLE credit_history IS 'Audit trail of all credit balance changes';
COMMENT ON TABLE processed_purchase_tags IS 'Audit log of purchase tags that have been processed. Tags are deleted from Circle after processing, allowing immediate repurchase.';
COMMENT ON VIEW member_summary IS 'Convenient view combining member data with credit information';