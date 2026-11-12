import { alias } from "drizzle-orm/sqlite-core";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  coupons,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  refunds,
  videoWatchEvents,
  LessonProgressStatus,
  RefundStatus,
  users,
} from "~/db/schema";
import { getDiscountForCountry } from "~/lib/ppp";

export const REFUND_WINDOW_DAYS = 14;
export const REFUND_WATCH_LIMIT_SECONDS = 2 * 60 * 60;
export const REFUND_COMPLETION_LIMIT = 0.5;

export type RefundEligibility =
  | {
      eligible: true;
      purchase: typeof purchases.$inferSelect;
      amount: number;
      lastDayInRefundWindow: string;
    }
  | { eligible: false; reason: string; status: 403 | 409 };

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(sql`${purchases.createdAt} desc`)
    .get();
}

function getEarlierRefundRequest(purchaseId: number) {
  return db
    .select({ status: refunds.status })
    .from(refunds)
    .where(eq(refunds.purchaseId, purchaseId))
    .get();
}

const EARLIER_REFUND_REQUEST_REASONS: Record<RefundStatus, string> = {
  [RefundStatus.Requested]:
    "You already have a Refund Request pending for this purchase.",
  [RefundStatus.Approved]: "This purchase has already been refunded.",
  [RefundStatus.Declined]:
    "Your Refund Request for this purchase was declined.",
};

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  return result?.count ?? 0;
}

function getSecondsWatched(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

// The Refund Window is counted in whole days, not hours — someone who buys at
// 23:00 should still get the whole of their fourteenth day.
function asDayString(when: Date) {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Whether the learner may raise a Refund Request for their latest Purchase of
 * this course. The course page and the Refund Request action both ask this,
 * so they can never disagree.
 */
export function getRefundEligibility(
  userId: number,
  course: { id: number; price: number }
): RefundEligibility {
  const purchase = getLatestPurchase(userId, course.id);

  if (!purchase) {
    return {
      eligible: false,
      reason: "You have not bought this course.",
      status: 403,
    };
  }

  // A Purchase gets one Refund Request. Once it is decided, either way, the
  // decision is final.
  const earlierRequest = getEarlierRefundRequest(purchase.id);

  if (earlierRequest) {
    return {
      eligible: false,
      reason: EARLIER_REFUND_REQUEST_REASONS[earlierRequest.status],
      status: 409,
    };
  }

  // A seat that came out of a team licence, and has been claimed, belongs to
  // the team — the learner cannot hand it back on their own.
  const claimedSeat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchase.id), isNotNull(coupons.redeemedAt))
    )
    .get();

  if (claimedSeat) {
    return {
      eligible: false,
      reason: "A claimed team seat cannot be refunded.",
      status: 403,
    };
  }

  const purchasedDay = asDayString(new Date(purchase.createdAt));
  const windowEnd = new Date(purchase.createdAt);
  windowEnd.setDate(windowEnd.getDate() + REFUND_WINDOW_DAYS);
  const lastDayInRefundWindow = asDayString(windowEnd);
  const today = asDayString(new Date());

  if (today < purchasedDay || today > lastDayInRefundWindow) {
    return {
      eligible: false,
      reason: `The ${REFUND_WINDOW_DAYS}-day Refund Window has closed.`,
      status: 403,
    };
  }

  const lessonIds = getLessonIdsForCourse(course.id);

  if (
    lessonIds.length > 0 &&
    getCompletedLessonCount(userId, lessonIds) / lessonIds.length >=
      REFUND_COMPLETION_LIMIT
  ) {
    return {
      eligible: false,
      reason: "You have completed too much of this course to get a refund.",
      status: 403,
    };
  }

  if (getSecondsWatched(userId, lessonIds) >= REFUND_WATCH_LIMIT_SECONDS) {
    return {
      eligible: false,
      reason: "You have watched too much of this course to get a refund.",
      status: 403,
    };
  }

  // A purchasing-power price is given back at the price that was paid, not at
  // the list price of the course.
  const pppDiscount = getDiscountForCountry(purchase.country);
  const amount = pppDiscount > 0 ? purchase.amountPaid : course.price;

  return { eligible: true, purchase, amount, lastDayInRefundWindow };
}

// ─── Deciding a Refund Request ───

export type RefundDecisionRefused = {
  ok: false;
  reason: string;
  status: 400 | 403 | 404 | 409;
};

export type ApprovalResult =
  { ok: true; amountRefunded: number } | RefundDecisionRefused;

export type DeclineResult = { ok: true } | RefundDecisionRefused;

const ALREADY_DECIDED = {
  ok: false,
  reason: "This Refund Request has already been decided.",
  status: 409,
} as const;

function findRefundRequestWithPurchase(refundRequestId: number) {
  const row = db
    .select({ request: refunds, purchase: purchases })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(eq(refunds.id, refundRequestId))
    .get();
  return row ?? null;
}

/**
 * The Refund Request, if this Admin may decide it. An Admin never decides
 * their own.
 */
function findDecidableRefundRequest(
  refundRequestId: number,
  adminId: number
):
  | ({ ok: true } & NonNullable<
      ReturnType<typeof findRefundRequestWithPurchase>
    >)
  | RefundDecisionRefused {
  const found = findRefundRequestWithPurchase(refundRequestId);

  if (!found) {
    return { ok: false, reason: "Refund Request not found.", status: 404 };
  }

  if (found.purchase.userId === adminId) {
    return {
      ok: false,
      reason: "Another Admin must decide your own Refund Request.",
      status: 403,
    };
  }

  return { ok: true, ...found };
}

/**
 * An Admin's Approval of a pending Refund Request: refunds exactly the Quoted
 * Refund Amount.
 */
export function approveRefundRequest(
  refundRequestId: number,
  adminId: number
): ApprovalResult {
  const found = findDecidableRefundRequest(refundRequestId, adminId);

  if (!found.ok) {
    return found;
  }

  const { request, purchase } = found;

  // Only a still-pending request is updated, so when two Admins decide at
  // once the first decision wins and the second changes nothing.
  const { changes } = db
    .update(refunds)
    .set({
      status: RefundStatus.Approved,
      amountRefunded: request.quotedAmount,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: adminId,
    })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .run();

  if (changes === 0) {
    return ALREADY_DECIDED;
  }

  // A team Purchase pays for seats, not for the buyer's own access. Claimed
  // seats make a Purchase ineligible, so only unclaimed ones can be left; they
  // are cancelled so nobody can redeem a refunded seat.
  const isTeamPurchase = !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchase.id))
    .get();

  if (isTeamPurchase) {
    db.delete(coupons)
      .where(
        and(eq(coupons.purchaseId, purchase.id), isNull(coupons.redeemedAt))
      )
      .run();
  } else {
    db.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, purchase.userId),
          eq(enrollments.courseId, purchase.courseId)
        )
      )
      .run();
  }

  return { ok: true, amountRefunded: request.quotedAmount };
}

/**
 * An Admin's Decline of a pending Refund Request. Nothing is refunded and the
 * learner keeps their access; the Decline Note says why.
 */
export function declineRefundRequest(
  refundRequestId: number,
  adminId: number,
  declineNote: string
): DeclineResult {
  const note = declineNote.trim();

  if (!note) {
    return {
      ok: false,
      reason: "Write a Decline Note telling the learner why.",
      status: 400,
    };
  }

  const found = findDecidableRefundRequest(refundRequestId, adminId);

  if (!found.ok) {
    return found;
  }

  const { changes } = db
    .update(refunds)
    .set({
      status: RefundStatus.Declined,
      declineNote: note,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: adminId,
    })
    .where(
      and(
        eq(refunds.id, refundRequestId),
        eq(refunds.status, RefundStatus.Requested)
      )
    )
    .run();

  if (changes === 0) {
    return ALREADY_DECIDED;
  }

  return { ok: true };
}

// ─── The Refund Request queue ───

const learners = alias(users, "learners");
const deciders = alias(users, "deciders");

function refundRequestRows() {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      quotedAmount: refunds.quotedAmount,
      amountRefunded: refunds.amountRefunded,
      declineNote: refunds.declineNote,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      learnerId: learners.id,
      learnerName: learners.name,
      learnerEmail: learners.email,
      courseId: courses.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      purchasedAt: purchases.createdAt,
      amountPaid: purchases.amountPaid,
      decidedByName: deciders.name,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(learners, eq(purchases.userId, learners.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(deciders, eq(refunds.resolvedByUserId, deciders.id));
}

/**
 * Everything an Admin needs to decide: pending Refund Requests, oldest first,
 * each with how much of the course the learner has used *now* — context for
 * the decision, not a rule — and the most recent decisions as an audit trail.
 */
export function getRefundRequestQueue(recentLimit = 20) {
  const pending = refundRequestRows()
    .where(eq(refunds.status, RefundStatus.Requested))
    .orderBy(asc(refunds.requestedAt))
    .all()
    .map((row) => {
      const lessonIds = getLessonIdsForCourse(row.courseId);
      return {
        ...row,
        secondsWatched: getSecondsWatched(row.learnerId, lessonIds),
        lessonsCompleted: getCompletedLessonCount(row.learnerId, lessonIds),
        lessonCount: lessonIds.length,
      };
    });

  const recentlyDecided = refundRequestRows()
    .where(ne(refunds.status, RefundStatus.Requested))
    .orderBy(desc(refunds.resolvedAt))
    .limit(recentLimit)
    .all();

  return { pending, recentlyDecided };
}

export function countPendingRefundRequests() {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(refunds)
    .where(eq(refunds.status, RefundStatus.Requested))
    .get();
  return row?.count ?? 0;
}

/** Who to tell about a decision, and about which course. */
export function getRefundRequestRecipient(refundRequestId: number) {
  return (
    refundRequestRows().where(eq(refunds.id, refundRequestId)).get() ?? null
  );
}
