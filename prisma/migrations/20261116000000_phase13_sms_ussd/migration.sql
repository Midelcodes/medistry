-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'FAILED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "ussdLocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ussdPinFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ussdPinHash" TEXT;

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "toHash" TEXT NOT NULL,
    "toLast3" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "providerStatus" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationDelivery_providerMessageId_idx" ON "NotificationDelivery"("providerMessageId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_toHash_idx" ON "NotificationDelivery"("toHash");

