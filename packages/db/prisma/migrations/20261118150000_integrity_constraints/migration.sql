-- Rules of docs/spec.md enforced by PostgreSQL rather than only by application code.

-- Append-only journals: the print access journal ("sans possibilité de modification") and the audit log.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;

CREATE TRIGGER "PrintEvent_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "PrintEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE OR TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Billing invariants: one owner per subscription, integer amounts never negative, valid percentages.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_one_owner"
  CHECK (("userId" IS NULL) <> ("organizationId" IS NULL));
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_seatCount_positive" CHECK ("seatCount" >= 1);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amount_nonnegative" CHECK ("amountXof" >= 0 AND "seats" >= 1);
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_prices_nonnegative"
  CHECK ("priceMonthlyXof" >= 0 AND "priceYearlyXof" >= 0);
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_volumeDiscountPercent_range"
  CHECK ("volumeDiscountPercent" IS NULL OR "volumeDiscountPercent" BETWEEN 0 AND 100);
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_percentOff_range" CHECK ("percentOff" BETWEEN 1 AND 100);
