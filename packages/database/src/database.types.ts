// Generated from versioned migrations by pnpm db:types. Do not hand edit.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export type Database = { public: { Tables: {
audit_logs: {
Row: {
id: string;
organization_id: string;
actor_user_id: string | null;
event_type: Database['public']['Enums']['audit_event_type'];
entity_type: string;
entity_id: string;
metadata: Json;
created_at: string;
};
Insert: {
id?: string;
organization_id: string;
actor_user_id?: string | null;
event_type: Database['public']['Enums']['audit_event_type'];
entity_type: string;
entity_id: string;
metadata?: Json;
created_at?: string;
};
Update: {
id?: string;
organization_id?: string;
actor_user_id?: string | null;
event_type?: Database['public']['Enums']['audit_event_type'];
entity_type?: string;
entity_id?: string;
metadata?: Json;
created_at?: string;
};
Relationships: [
{ foreignKeyName: "audit_logs_organization_id_fkey"; columns: ["organization_id"]; isOneToOne: false; referencedRelation: "organizations"; referencedColumns: ["id"] },
{ foreignKeyName: "audit_logs_actor_user_id_fkey"; columns: ["actor_user_id"]; isOneToOne: false; referencedRelation: "profiles"; referencedColumns: ["id"] },
];
};
check_ins: {
Row: {
id: string;
organization_id: string;
event_id: string;
ticket_id: string;
checked_in_by: string;
checked_in_at: string;
gate: string | null;
metadata: Json;
};
Insert: {
id?: string;
organization_id: string;
event_id: string;
ticket_id: string;
checked_in_by: string;
checked_in_at?: string;
gate?: string | null;
metadata?: Json;
};
Update: {
id?: string;
organization_id?: string;
event_id?: string;
ticket_id?: string;
checked_in_by?: string;
checked_in_at?: string;
gate?: string | null;
metadata?: Json;
};
Relationships: [
{ foreignKeyName: "check_ins_organization_id_ticket_id_event_id_fkey"; columns: ["organization_id","ticket_id","event_id"]; isOneToOne: false; referencedRelation: "tickets"; referencedColumns: ["organization_id","id","event_id"] },
{ foreignKeyName: "check_ins_organization_id_checked_in_by_fkey"; columns: ["organization_id","checked_in_by"]; isOneToOne: false; referencedRelation: "organization_members"; referencedColumns: ["organization_id","user_id"] },
];
};
customers: {
Row: {
id: string;
organization_id: string;
full_name: string;
email: string;
phone: string | null;
created_at: string;
updated_at: string;
};
Insert: {
id?: string;
organization_id: string;
full_name: string;
email: string;
phone?: string | null;
created_at?: string;
updated_at?: string;
};
Update: {
id?: string;
organization_id?: string;
full_name?: string;
email?: string;
phone?: string | null;
created_at?: string;
updated_at?: string;
};
Relationships: [
{ foreignKeyName: "customers_organization_id_fkey"; columns: ["organization_id"]; isOneToOne: false; referencedRelation: "organizations"; referencedColumns: ["id"] },
];
};
events: {
Row: {
id: string;
organization_id: string;
location_id: string;
name: string;
slug: string;
description: string | null;
starts_at: string;
ends_at: string;
timezone: string;
status: Database['public']['Enums']['event_status'];
sales_start: string | null;
sales_end: string | null;
capacity: number | null;
created_at: string;
updated_at: string;
};
Insert: {
id?: string;
organization_id: string;
location_id: string;
name: string;
slug: string;
description?: string | null;
starts_at: string;
ends_at: string;
timezone: string;
status?: Database['public']['Enums']['event_status'];
sales_start?: string | null;
sales_end?: string | null;
capacity?: number | null;
created_at?: string;
updated_at?: string;
};
Update: {
id?: string;
organization_id?: string;
location_id?: string;
name?: string;
slug?: string;
description?: string | null;
starts_at?: string;
ends_at?: string;
timezone?: string;
status?: Database['public']['Enums']['event_status'];
sales_start?: string | null;
sales_end?: string | null;
capacity?: number | null;
created_at?: string;
updated_at?: string;
};
Relationships: [
{ foreignKeyName: "events_organization_id_fkey"; columns: ["organization_id"]; isOneToOne: false; referencedRelation: "organizations"; referencedColumns: ["id"] },
{ foreignKeyName: "events_organization_id_location_id_fkey"; columns: ["organization_id","location_id"]; isOneToOne: false; referencedRelation: "locations"; referencedColumns: ["organization_id","id"] },
];
};
locations: {
Row: {
id: string;
organization_id: string;
name: string;
slug: string;
address: string | null;
timezone: string;
created_at: string;
updated_at: string;
};
Insert: {
id?: string;
organization_id: string;
name: string;
slug: string;
address?: string | null;
timezone: string;
created_at?: string;
updated_at?: string;
};
Update: {
id?: string;
organization_id?: string;
name?: string;
slug?: string;
address?: string | null;
timezone?: string;
created_at?: string;
updated_at?: string;
};
Relationships: [
{ foreignKeyName: "locations_organization_id_fkey"; columns: ["organization_id"]; isOneToOne: false; referencedRelation: "organizations"; referencedColumns: ["id"] },
];
};
order_items: {
Row: {
id: string;
organization_id: string;
order_id: string;
event_id: string;
currency: string;
ticket_type_id: string;
quantity: number;
unit_price: number;
subtotal: number;
created_at: string;
};
Insert: {
id?: string;
organization_id: string;
order_id: string;
event_id: string;
currency: string;
ticket_type_id: string;
quantity: number;
unit_price: number;
subtotal: number;
created_at?: string;
};
Update: {
id?: string;
organization_id?: string;
order_id?: string;
event_id?: string;
currency?: string;
ticket_type_id?: string;
quantity?: number;
unit_price?: number;
subtotal?: number;
created_at?: string;
};
Relationships: [
{ foreignKeyName: "order_items_organization_id_order_id_event_id_currency_fkey"; columns: ["organization_id","order_id","event_id","currency"]; isOneToOne: false; referencedRelation: "orders"; referencedColumns: ["organization_id","id","event_id","currency"] },
{ foreignKeyName: "order_items_organization_id_ticket_type_id_event_id_curren_fkey"; columns: ["organization_id","ticket_type_id","event_id","currency"]; isOneToOne: false; referencedRelation: "ticket_types"; referencedColumns: ["organization_id","id","event_id","currency"] },
];
};
orders: {
Row: {
id: string;
organization_id: string;
event_id: string;
customer_id: string;
public_code: string;
status: Database['public']['Enums']['order_status'];
currency: string;
subtotal: number;
total: number;
reserved_until: string | null;
created_at: string;
updated_at: string;
};
Insert: {
id?: string;
organization_id: string;
event_id: string;
customer_id: string;
public_code: string;
status?: Database['public']['Enums']['order_status'];
currency: string;
subtotal?: number;
total?: number;
reserved_until?: string | null;
created_at?: string;
updated_at?: string;
};
Update: {
id?: string;
organization_id?: string;
event_id?: string;
customer_id?: string;
public_code?: string;
status?: Database['public']['Enums']['order_status'];
currency?: string;
subtotal?: number;
total?: number;
reserved_until?: string | null;
created_at?: string;
updated_at?: string;
};
Relationships: [
{ foreignKeyName: "orders_organization_id_event_id_fkey"; columns: ["organization_id","event_id"]; isOneToOne: false; referencedRelation: "events"; referencedColumns: ["organization_id","id"] },
{ foreignKeyName: "orders_organization_id_customer_id_fkey"; columns: ["organization_id","customer_id"]; isOneToOne: false; referencedRelation: "customers"; referencedColumns: ["organization_id","id"] },
];
};
organization_members: {
Row: {
organization_id: string;
user_id: string;
role: Database['public']['Enums']['member_role'];
created_at: string;
updated_at: string;
};
Insert: {
organization_id: string;
user_id: string;
role: Database['public']['Enums']['member_role'];
created_at?: string;
updated_at?: string;
};
Update: {
organization_id?: string;
user_id?: string;
role?: Database['public']['Enums']['member_role'];
created_at?: string;
updated_at?: string;
};
Relationships: [
{ foreignKeyName: "organization_members_organization_id_fkey"; columns: ["organization_id"]; isOneToOne: false; referencedRelation: "organizations"; referencedColumns: ["id"] },
{ foreignKeyName: "organization_members_user_id_fkey"; columns: ["user_id"]; isOneToOne: false; referencedRelation: "profiles"; referencedColumns: ["id"] },
];
};
organizations: {
Row: {
id: string;
name: string;
slug: string;
created_at: string;
updated_at: string;
};
Insert: {
id?: string;
name: string;
slug: string;
created_at?: string;
updated_at?: string;
};
Update: {
id?: string;
name?: string;
slug?: string;
created_at?: string;
updated_at?: string;
};
Relationships: [
];
};
payments: {
Row: {
id: string;
organization_id: string;
order_id: string;
provider: string;
provider_payment_id: string | null;
method: string | null;
status: Database['public']['Enums']['payment_status'];
amount: number;
currency: string;
metadata: Json;
created_at: string;
updated_at: string;
};
Insert: {
id?: string;
organization_id: string;
order_id: string;
provider: string;
provider_payment_id?: string | null;
method?: string | null;
status?: Database['public']['Enums']['payment_status'];
amount: number;
currency: string;
metadata?: Json;
created_at?: string;
updated_at?: string;
};
Update: {
id?: string;
organization_id?: string;
order_id?: string;
provider?: string;
provider_payment_id?: string | null;
method?: string | null;
status?: Database['public']['Enums']['payment_status'];
amount?: number;
currency?: string;
metadata?: Json;
created_at?: string;
updated_at?: string;
};
Relationships: [
{ foreignKeyName: "payments_organization_id_order_id_currency_fkey"; columns: ["organization_id","order_id","currency"]; isOneToOne: false; referencedRelation: "orders"; referencedColumns: ["organization_id","id","currency"] },
];
};
profiles: {
Row: {
id: string;
full_name: string | null;
created_at: string;
updated_at: string;
};
Insert: {
id: string;
full_name?: string | null;
created_at?: string;
updated_at?: string;
};
Update: {
id?: string;
full_name?: string | null;
created_at?: string;
updated_at?: string;
};
Relationships: [
];
};
ticket_types: {
Row: {
id: string;
organization_id: string;
event_id: string;
name: string;
description: string | null;
price: number;
currency: string;
capacity: number;
sales_start: string | null;
sales_end: string | null;
status: Database['public']['Enums']['ticket_type_status'];
sort_order: number;
created_at: string;
updated_at: string;
};
Insert: {
id?: string;
organization_id: string;
event_id: string;
name: string;
description?: string | null;
price: number;
currency: string;
capacity: number;
sales_start?: string | null;
sales_end?: string | null;
status?: Database['public']['Enums']['ticket_type_status'];
sort_order?: number;
created_at?: string;
updated_at?: string;
};
Update: {
id?: string;
organization_id?: string;
event_id?: string;
name?: string;
description?: string | null;
price?: number;
currency?: string;
capacity?: number;
sales_start?: string | null;
sales_end?: string | null;
status?: Database['public']['Enums']['ticket_type_status'];
sort_order?: number;
created_at?: string;
updated_at?: string;
};
Relationships: [
{ foreignKeyName: "ticket_types_organization_id_event_id_fkey"; columns: ["organization_id","event_id"]; isOneToOne: false; referencedRelation: "events"; referencedColumns: ["organization_id","id"] },
];
};
tickets: {
Row: {
id: string;
organization_id: string;
event_id: string;
order_id: string;
order_item_id: string;
ticket_type_id: string;
public_code: string;
secure_token_hash: string;
status: Database['public']['Enums']['ticket_status'];
issued_at: string;
redeemed_at: string | null;
created_at: string;
updated_at: string;
};
Insert: {
id?: string;
organization_id: string;
event_id: string;
order_id: string;
order_item_id: string;
ticket_type_id: string;
public_code: string;
secure_token_hash: string;
status?: Database['public']['Enums']['ticket_status'];
issued_at?: string;
redeemed_at?: string | null;
created_at?: string;
updated_at?: string;
};
Update: {
id?: string;
organization_id?: string;
event_id?: string;
order_id?: string;
order_item_id?: string;
ticket_type_id?: string;
public_code?: string;
secure_token_hash?: string;
status?: Database['public']['Enums']['ticket_status'];
issued_at?: string;
redeemed_at?: string | null;
created_at?: string;
updated_at?: string;
};
Relationships: [
{ foreignKeyName: "tickets_organization_id_order_item_id_order_id_event_id_ti_fkey"; columns: ["organization_id","order_item_id","order_id","event_id","ticket_type_id"]; isOneToOne: false; referencedRelation: "order_items"; referencedColumns: ["organization_id","id","order_id","event_id","ticket_type_id"] },
];
};
}; Views: { [_ in never]: never }; Functions: { [_ in never]: never }; Enums: {
audit_event_type: "order_created" | "payment_confirmed" | "ticket_issued" | "ticket_redeemed" | "ticket_redeem_attempt" | "ticket_resent" | "complimentary_created" | "ticket_cancelled" | "refund";
event_status: "draft" | "published" | "sales_closed" | "completed" | "cancelled";
member_role: "owner" | "manager" | "door";
order_status: "draft" | "pending_payment" | "paid" | "expired" | "cancelled" | "refunded";
payment_status: "pending" | "approved" | "rejected" | "cancelled" | "refunded";
ticket_status: "valid" | "redeemed" | "cancelled" | "refunded";
ticket_type_status: "draft" | "active" | "paused" | "sold_out" | "archived";
}; CompositeTypes: { [_ in never]: never }; }; };
