import { useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useFetcher } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AlertTriangle, ReceiptText } from "lucide-react";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { db } from "~/db";
import { RefundStatus, UserRole, users } from "~/db/schema";
import {
  approveRefundRequest,
  declineRefundRequest,
  getRefundRequestQueue,
  getRefundRequestRecipient,
} from "~/lib/refunds.server";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

const refundDecisionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineNote: z
      .string()
      .trim()
      .min(1, "Write a Decline Note telling the learner why.")
      .max(1000, "Please keep the Decline Note under 1000 characters."),
  }),
]);

type ActionData = { ok: true; message: string } | { ok: false; error: string };

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline Refund Requests" },
  ];
}

async function requireAdmin(request: Request) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data(
      "Select a user from the DevUI panel to review Refund Requests.",
      {
        status: 401,
      }
    );
  }

  const currentUser = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can decide Refund Requests.", { status: 403 });
  }

  return currentUser;
}

export async function loader({ request }: Route.LoaderArgs) {
  const admin = await requireAdmin(request);
  return { adminId: admin.id, ...getRefundRequestQueue() };
}

/**
 * The decision email the learner was promised when they asked. There is no
 * mail transport wired up yet, so the built message goes to the server log.
 */
function buildRefundDecisionEmail(
  recipient: { learnerName: string; learnerEmail: string; courseTitle: string },
  decision:
    | { status: RefundStatus.Approved; amountRefunded: number }
    | { status: RefundStatus.Declined; declineNote: string }
) {
  const outcome =
    decision.status === RefundStatus.Approved
      ? [
          `Your Refund Request for "${recipient.courseTitle}" has been approved.`,
          `We are refunding ${formatPrice(decision.amountRefunded)}, and your access to the course has ended.`,
        ]
      : [
          `Your Refund Request for "${recipient.courseTitle}" has been declined.`,
          "",
          decision.declineNote,
          "",
          "You keep full access to the course.",
        ];

  return {
    to: recipient.learnerEmail,
    subject: `Refund Request ${decision.status} — ${recipient.courseTitle}`,
    body: [
      `Hi ${recipient.learnerName},`,
      "",
      ...outcome,
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const parsed = parseFormData(await request.formData(), refundDecisionSchema);

  if (!parsed.success) {
    return data<ActionData>(
      { ok: false, error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const { refundRequestId } = parsed.data;
  const recipient = getRefundRequestRecipient(refundRequestId);

  if (parsed.data.intent === "approve") {
    const result = approveRefundRequest(refundRequestId, admin.id);

    if (!result.ok) {
      return data<ActionData>(
        { ok: false, error: result.reason },
        { status: result.status }
      );
    }

    if (recipient) {
      logEmail(
        buildRefundDecisionEmail(recipient, {
          status: RefundStatus.Approved,
          amountRefunded: result.amountRefunded,
        })
      );
    }

    return data<ActionData>({
      ok: true,
      message: `Refunded ${formatPrice(result.amountRefunded)}.`,
    });
  }

  const { declineNote } = parsed.data;
  const result = declineRefundRequest(refundRequestId, admin.id, declineNote);

  if (!result.ok) {
    return data<ActionData>(
      { ok: false, error: result.reason },
      { status: result.status }
    );
  }

  if (recipient) {
    logEmail(
      buildRefundDecisionEmail(recipient, {
        status: RefundStatus.Declined,
        declineNote,
      })
    );
  }

  return data<ActionData>({ ok: true, message: "Refund Request declined." });
}

function logEmail(email: { to: string; subject: string; body: string }) {
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatWatchTime(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

type PendingRequest = Route.ComponentProps["loaderData"]["pending"][number];
type DecidedRequest =
  Route.ComponentProps["loaderData"]["recentlyDecided"][number];

function PendingRequestCard({
  request,
  isOwnRequest,
}: {
  request: PendingRequest;
  isOwnRequest: boolean;
}) {
  const fetcher = useFetcher<ActionData>();
  const [step, setStep] = useState<"choose" | "confirm-approve" | "decline">(
    "choose"
  );
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      toast.success(fetcher.data.message);
    } else {
      toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-medium">
              {request.learnerName}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                {request.learnerEmail}
              </span>
            </p>
            <Link
              to={`/courses/${request.courseSlug}`}
              className="text-sm hover:underline"
            >
              {request.courseTitle}
            </Link>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Quoted Refund Amount
            </p>
            <p className="text-2xl font-semibold">
              {formatPrice(request.quotedAmount)}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Purchased</dt>
            <dd>{formatDate(request.purchasedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Paid</dt>
            <dd>{formatPrice(request.amountPaid)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Watched so far</dt>
            <dd>{formatWatchTime(request.secondsWatched)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Lessons completed</dt>
            <dd>
              {request.lessonsCompleted} of {request.lessonCount}
            </dd>
          </div>
        </dl>

        <blockquote className="border-l-2 border-border pl-3 text-sm italic">
          {request.reason}
          <span className="mt-1 block text-xs not-italic text-muted-foreground">
            Asked {formatDate(request.requestedAt)}
          </span>
        </blockquote>

        {isOwnRequest ? (
          <p className="text-sm text-muted-foreground">
            This is your own Refund Request. Another Admin must decide it.
          </p>
        ) : step === "choose" ? (
          <div className="flex gap-2">
            <Button onClick={() => setStep("confirm-approve")}>Approve</Button>
            <Button variant="outline" onClick={() => setStep("decline")}>
              Decline
            </Button>
          </div>
        ) : step === "confirm-approve" ? (
          <fetcher.Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="approve" />
            <input type="hidden" name="refundRequestId" value={request.id} />
            <p className="text-sm">
              Refund {formatPrice(request.quotedAmount)} to{" "}
              {request.learnerName} and end their access to{" "}
              {request.courseTitle}? This cannot be undone.
            </p>
            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Refunding…" : "Confirm Approval"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep("choose")}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        ) : (
          <fetcher.Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="decline" />
            <input type="hidden" name="refundRequestId" value={request.id} />
            <label
              className="block text-sm font-medium"
              htmlFor={`decline-note-${request.id}`}
            >
              Decline Note — sent to the learner
            </label>
            <Textarea
              id={`decline-note-${request.id}`}
              name="declineNote"
              required
              maxLength={1000}
              placeholder="Tell the learner why their Refund Request was declined."
            />
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="destructive"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Declining…" : "Decline Refund Request"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep("choose")}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        )}
      </CardContent>
    </Card>
  );
}

function DecidedRequestRow({ request }: { request: DecidedRequest }) {
  const approved = request.status === RefundStatus.Approved;
  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3 text-sm">
        <p className="font-medium">{request.learnerName}</p>
        <p className="text-muted-foreground">{request.courseTitle}</p>
      </td>
      <td className="px-4 py-3 text-sm">
        <span
          className={
            approved
              ? "inline-flex rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400"
              : "inline-flex rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-900/30 dark:text-gray-400"
          }
        >
          {approved ? "Approved" : "Declined"}
        </span>
        {approved ? (
          <p className="mt-1">{formatPrice(request.amountRefunded)}</p>
        ) : (
          <p className="mt-1 text-muted-foreground">{request.declineNote}</p>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">
        {request.decidedByName ?? "—"}
        <br />
        {formatDate(request.resolvedAt)}
      </td>
    </tr>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { adminId, pending, recentlyDecided } = loaderData;

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or decline each request. Oldest first.
        </p>
      </div>

      <section className="mb-12 space-y-4">
        <h2 className="text-lg font-semibold">
          Pending{" "}
          <span className="text-muted-foreground">({pending.length})</span>
        </h2>
        {pending.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <ReceiptText className="mx-auto mb-3 size-8 text-muted-foreground/50" />
              <p className="text-muted-foreground">
                No Refund Requests are waiting for a decision.
              </p>
            </CardContent>
          </Card>
        ) : (
          pending.map((request) => (
            <PendingRequestCard
              key={request.id}
              request={request}
              isOwnRequest={request.learnerId === adminId}
            />
          ))
        )}
      </section>

      {recentlyDecided.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Recently decided</h2>
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Learner
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Decision
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Decided by
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentlyDecided.map((request) => (
                      <DecidedRequestRow key={request.id} request={request} />
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading Refund Requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
    } else if (error.status === 403) {
      title = "Access denied";
    } else {
      title = `Error ${error.status}`;
    }
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
