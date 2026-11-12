import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  approveRefundRequest,
  declineRefundRequest,
  getRefundEligibility,
} from "./refunds.server";

let base: ReturnType<typeof seedBaseData>;
let admin: typeof schema.users.$inferSelect;

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
  admin = testDb
    .insert(schema.users)
    .values({
      name: "Ada Admin",
      email: "ada@example.com",
      role: schema.UserRole.Admin,
    })
    .returning()
    .get();
});

function buyCourse(userId: number, amountPaid = 7900) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({ userId, courseId: base.course.id, amountPaid })
    .returning()
    .get();
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
  return purchase;
}

function raiseRefundRequest(purchaseId: number, quotedAmount = 7900) {
  return testDb
    .insert(schema.refunds)
    .values({
      purchaseId,
      reason: "The course was not what I expected.",
      quotedAmount,
    })
    .returning()
    .get();
}

function findRefundRequest(id: number) {
  return testDb
    .select()
    .from(schema.refunds)
    .all()
    .find((row) => row.id === id);
}

describe("approveRefundRequest", () => {
  it("refunds exactly the Quoted Refund Amount and records who approved it", () => {
    const purchase = buyCourse(base.user.id, 7900);
    const request = raiseRefundRequest(purchase.id, 4900);

    const result = approveRefundRequest(request.id, admin.id);

    expect(result).toEqual({ ok: true, amountRefunded: 4900 });
    expect(findRefundRequest(request.id)).toMatchObject({
      status: schema.RefundStatus.Approved,
      amountRefunded: 4900,
      resolvedByUserId: admin.id,
    });
    expect(findRefundRequest(request.id)?.resolvedAt).not.toBeNull();
  });

  it("ends the learner's access to the course", () => {
    const purchase = buyCourse(base.user.id);
    const request = raiseRefundRequest(purchase.id);

    approveRefundRequest(request.id, admin.id);

    expect(enrolledUserIds()).toEqual([]);
  });

  it("cancels the unclaimed seats of a team Purchase, leaving the buyer's own enrollment alone", () => {
    // The buyer is enrolled through their own, separate Purchase.
    buyCourse(base.user.id);
    const teamPurchase = buyTeamSeats(base.user.id, 2);
    const request = raiseRefundRequest(teamPurchase.id, 15800);

    approveRefundRequest(request.id, admin.id);

    expect(teamSeatCodes(teamPurchase.id)).toEqual([]);
    expect(enrolledUserIds()).toEqual([base.user.id]);
  });

  it("refuses an Admin approving their own Refund Request", () => {
    const purchase = buyCourse(admin.id);
    const request = raiseRefundRequest(purchase.id);

    const result = approveRefundRequest(request.id, admin.id);

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(findRefundRequest(request.id)?.status).toBe(
      schema.RefundStatus.Requested
    );
    expect(enrolledUserIds()).toEqual([admin.id]);
  });

  it("refuses a Refund Request another Admin has already decided", () => {
    const otherAdmin = testDb
      .insert(schema.users)
      .values({
        name: "Otto Admin",
        email: "otto@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    const purchase = buyCourse(base.user.id);
    const request = raiseRefundRequest(purchase.id);
    approveRefundRequest(request.id, otherAdmin.id);

    const result = approveRefundRequest(request.id, admin.id);

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(findRefundRequest(request.id)?.resolvedByUserId).toBe(otherAdmin.id);
  });
});

function buyTeamSeats(userId: number, seats: number) {
  const purchase = testDb
    .insert(schema.purchases)
    .values({ userId, courseId: base.course.id, amountPaid: 7900 * seats })
    .returning()
    .get();
  const team = testDb.insert(schema.teams).values({}).returning().get();
  for (let i = 0; i < seats; i++) {
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `SEAT-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .run();
  }
  return purchase;
}

function teamSeatCodes(purchaseId: number) {
  return testDb
    .select()
    .from(schema.coupons)
    .all()
    .filter((row) => row.purchaseId === purchaseId)
    .map((row) => row.code);
}

describe("declineRefundRequest", () => {
  it("records the Decline Note, refunds nothing and leaves access alone", () => {
    const purchase = buyCourse(base.user.id);
    const request = raiseRefundRequest(purchase.id);

    const result = declineRefundRequest(
      request.id,
      admin.id,
      "You have finished most of the course."
    );

    expect(result).toEqual({ ok: true });
    expect(findRefundRequest(request.id)).toMatchObject({
      status: schema.RefundStatus.Declined,
      declineNote: "You have finished most of the course.",
      amountRefunded: null,
      resolvedByUserId: admin.id,
    });
    expect(enrolledUserIds()).toEqual([base.user.id]);
  });

  it("refuses a Decline without a Decline Note", () => {
    const purchase = buyCourse(base.user.id);
    const request = raiseRefundRequest(purchase.id);

    const result = declineRefundRequest(request.id, admin.id, "   ");

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(findRefundRequest(request.id)?.status).toBe(
      schema.RefundStatus.Requested
    );
  });

  it("refuses an Admin declining their own Refund Request", () => {
    const purchase = buyCourse(admin.id);
    const request = raiseRefundRequest(purchase.id);

    const result = declineRefundRequest(request.id, admin.id, "Not eligible.");

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(findRefundRequest(request.id)?.status).toBe(
      schema.RefundStatus.Requested
    );
  });

  it("refuses to overturn a Refund Request that was already approved", () => {
    const purchase = buyCourse(base.user.id);
    const request = raiseRefundRequest(purchase.id);
    const approver = testDb
      .insert(schema.users)
      .values({
        name: "Otto Admin",
        email: "otto@example.com",
        role: schema.UserRole.Admin,
      })
      .returning()
      .get();
    approveRefundRequest(request.id, approver.id);

    const result = declineRefundRequest(request.id, admin.id, "Too late.");

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(findRefundRequest(request.id)).toMatchObject({
      status: schema.RefundStatus.Approved,
      declineNote: null,
    });
  });
});

describe("getRefundEligibility", () => {
  it("is eligible for a fresh Purchase with no Refund Request", () => {
    buyCourse(base.user.id);

    expect(getRefundEligibility(base.user.id, base.course)).toMatchObject({
      eligible: true,
    });
  });

  it("is not eligible once a Refund Request for the Purchase was declined", () => {
    const purchase = buyCourse(base.user.id);
    const request = raiseRefundRequest(purchase.id);
    declineRefundRequest(request.id, admin.id, "Not this time.");

    expect(getRefundEligibility(base.user.id, base.course)).toMatchObject({
      eligible: false,
      status: 409,
    });
  });
});

function enrolledUserIds() {
  return testDb
    .select()
    .from(schema.enrollments)
    .all()
    .filter((row) => row.courseId === base.course.id)
    .map((row) => row.userId);
}
