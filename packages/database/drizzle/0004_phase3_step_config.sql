ALTER TABLE "execution_steps" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;
