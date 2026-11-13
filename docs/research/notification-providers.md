# Which notification providers fit Cadence?

Research for issue #3, part of map #1 "Wayfinder: In-app Notifications". Gathered 2026-11-13.

The terms follow `GLOSSARY.md`. A **Notification** is something that happened, addressed to the one person it concerns. A **Channel** is in-app or email.

Cadence's constraints are React Router 8.3 (framework mode, SSR), React 19.2, and users identified by an integer id in the session. A DevUI switches the current user in dev, and transactional email already goes out through Postmark (`app/lib/mailer.server.ts`, which POSTs to `api.postmarkapp.com/email` with a server token on the `outbound` stream). The map requires a free tier that covers dev usage.

## Recommendation

**Front-runner: Knock.** Novu is the runner-up, and the better pick only if self-hosting or open source becomes a hard requirement.

Why Knock:

1. **Prebuilt feed and headless hooks come from one package.** `@knocklabs/react` ships `NotificationFeedPopover` and `NotificationIconButton`. The same package also exports `useNotifications`, `useNotificationStore` and `useKnockFeed`. The "prebuilt vs own UI" question on the map can therefore be settled later without changing provider.
2. **It server-renders under React 19 with no extra work.** The peer range includes React 19, and in our test a server render of `KnockProvider` with `NotificationIconButton` worked in Node (see [SSR smoke test](#ssr-smoke-test)).
3. **It can send email through Cadence's existing Postmark server.** The Postmark channel takes our server API token and From address and uses the `outbound` stream by default. Knock also reads Postmark's delivery and bounce webhooks back. Knock does not bill for Postmark sends.
4. **The feed tracks the right states.** Each feed message can be seen, read, interacted or archived, can hold several of those at once, and comes with unread and unseen counts for a badge. New messages arrive over a websocket.
5. **Its auth model suits Cadence.** Our server signs the user token with RS256 and a private key, using `signUserToken` from `@knocklabs/node`. That costs no network round trip. The `sub` claim is `String(user.id)`.
6. **The free tier is enough for dev.** It allows 10,000 messages a month with unlimited feed retention, and going over has no hard cap.

The main costs of Knock are that it can't be self-hosted, the paid tier jumps to $250/month, and the free plan keeps Knock branding.

## Comparison

| | **Knock** | **Novu** | **Courier** | **MagicBell** | **SuprSend** (alt.) |
|---|---|---|---|---|---|
| Prebuilt in-app UI | Feed popover, bell, toasts (`@knocklabs/react`) | `<Inbox />`, Bell, Notifications, Preferences (`@novu/react`) | `<CourierInbox />`, toasts, preferences (`@trycourier/courier-react`, web components underneath) | `Inbox`, `FloatingInbox` (`@magicbell/react`) | Inbox (not assessed in depth) |
| Headless API | Hooks (`useNotifications`, `useNotificationStore`) plus REST feed API | Hooks (`useNotifications`, `useCounts`, `useNovu`) | Custom views or low-level APIs | `@magicbell/react-headless` | Not assessed |
| React 19 peer range | `^17 \|\| ^18 \|\| ^19` | `^18 \|\| ^19` | `>=18` | headless: `>=18.3.1` | Not assessed |
| SSR render in Node (our test) | Renders the markup | Renders a placeholder, hydrates on the client | Renders nothing (a client-only web component) | Not tested | Not tested |
| Real-time | Websocket | Websocket (`socketUrl`), events through `novu.on()` | Real-time sync across devices | Websocket (`reconnecting-websocket` is a dependency) | Not assessed |
| Read/seen/archived | seen, read, interacted, archived | read, seen, archive (snooze is Cloud-only) | read, opened, archived | read/unread documented | Not assessed |
| Email through our Postmark | Yes: our server token, `outbound` stream, delivery webhooks read back | Yes: our server token (delivery webhooks undocumented) | Yes: our server token, `MessageStream` override, failover routing | **No Postmark** (SES, Mailgun, SendGrid, SMTP, Ping) | Postmark not mentioned |
| Recipient auth | RS256 JWT, `sub` = user id, signed locally | HMAC-SHA256 of `subscriberId` with the secret key, as `subscriberHash` | JWT from `POST /auth/issue-token` (an API call), with scopes | HS256 JWT with `user_external_id` | Not assessed |
| Free tier | 10k messages/mo, no hard cap | 10k workflow runs/mo, **5 workflows**, 24 h activity log | 10k sends/mo (one send covers all its Channels) | **1k deliveries/mo** | 10k notifications/mo, branded |
| Paid entry | Starter $250/mo | Pro from $30/mo | $0.005/send | $249/mo | $100/mo |
| Self-host / OSS | No (Enterprise: "dedicated infrastructure") | **MIT core** plus commercial `enterprise/`; Community self-host | No | No | Enterprise only |

## Detail by provider

### Knock

- **Pricing:** Free is $0 for up to 10,000 messages sent. A "message" is one message to one user on one Channel, and bounced or failed messages aren't billed. Feeds, workflows, Channels and team members are unlimited, and feed retention is unlimited on every plan. Knock doesn't hard-cap Free and contacts you instead. Starter is $250/month plus usage, at $0.005 per message after 50k. Removing the branding needs Starter. Knock "doesn't bill for downstream providers such as Postmark". The page shows no date. Source: <https://knock.app/pricing> (fetched 2026-11-13).
- **React SDK:** The latest `@knocklabs/react` is 0.15.1, modified 2026-11-06. Its peer deps are `react ^17 || ^18 || ^19`, with optional `next` and `@tanstack/react-router` adapters. There's no React Router adapter, and our feed doesn't need one. The ESM entry carries a `"use client"` directive. `KnockProvider` takes an `enabled` prop that keeps it idle (no identify, no requests, no websocket) until identity is ready. Turning it off "disconnects and clears its data like a logout". Sources: `npm view @knocklabs/react`, <https://github.com/knocklabs/javascript/tree/main/packages/react>.
- **Headless hooks:** `useNotifications(knockClient, channelId, options)` and `useNotificationStore(feedClient)` return `items` plus `metadata` (`unread_count`, `unseen_count`). In headless mode we must call `markAsSeen` or `markAllAsSeen` ourselves. The prebuilt popover does it automatically. Source: <https://docs.knock.app/in-app-ui/react/custom-notifications-ui>.
- **Feed and real-time:** Messages are pushed over a websocket. They can be unread, read, seen or archived, and interactions are tracked. The feed can be filtered by status and returns aggregate counts. Sources: <https://docs.knock.app/in-app-ui/feeds/overview>, <https://docs.knock.app/send-notifications/message-statuses>.
- **Postmark:** Knock needs our Postmark server's API key and a From address. With no stream set, Postmark uses the `outbound` transactional stream, the same one `mailer.server.ts` uses today. An optional incoming webhook maps Postmark Delivery and Bounce events onto Knock message statuses. Source: <https://docs.knock.app/integrations/email/postmark>.
- **Auth:** Enhanced security mode is off by default. Without it, "a request with your public key can act as any user". With it on, clients need a JWT signed with RS256 and the dashboard signing key (`KNOCK_SIGNING_KEY`). `sub` is required, and `iat` and `exp` are recommended. `signUserToken` from `@knocklabs/node/lib/tokenSigner` defaults to a 3600 s expiry. `onUserTokenExpiring` handles refresh. Enhanced security can stay off in the development environment. Source: <https://docs.knock.app/in-app-ui/security-and-authentication>.

### Novu

- **Pricing:** Free is $0 with 10,000 workflow runs a month, **5 workflows**, 2 environments, 24-hour activity-feed retention and 3 team members. Pro starts at $30 with 30k runs and 20 workflows. Team starts at $250, and overage on paid plans is $1.20 per 1k. The page shows © 2026 but no effective date. Source: <https://novu.co/pricing>.
- **React SDK:** `@novu/react` is 3.19.2, modified 2026-09-24, with peers `react ^18 || ^19`. Headless mode provides `NovuProvider`, `useNotifications` (pagination, `archived` filter), `useCounts` (unread, unseen, total) and `useNovu`. `novu.on('notifications.notification_received')` exposes real-time events. Per-item `read` and `archive` calls go through the client. `seenAll`, `archiveAll` and `archiveAllRead` are bulk helpers. The prebuilt `<Inbox />` marks an item seen after it has been visible for at least 1 s. Sources: <https://docs.novu.co/platform/inbox/headless-mode.md>, <https://docs.novu.co/platform/sdks/react/hooks/use-notifications.md>.
- **Auth:** `subscriberHash` = HMAC-SHA256(secret key, `subscriberId`), as lowercase hex, passed to `<Inbox />`. You enable it per environment in the In-App integration. If HMAC is on and the hash is missing, the Inbox won't load. Source: <https://docs.novu.co/platform/inbox/prepare-for-production>.
- **Postmark:** Novu needs our Postmark server API token and a From address. The docs don't mention delivery webhooks. Source: <https://docs.novu.co/platform/integrations/email/postmark>.
- **Self-host / OSS:** The core is MIT. The `enterprise/` folder is under a commercial license. Source: <https://github.com/novuhq/novu>. The docs describe Community Self-Hosted as "how you test and experiment with notifications infrastructure". It includes Inbox, Bell, Preferences and Digest, but not snooze or branding removal. Source: <https://docs.novu.co/community/self-hosted-and-novu-cloud.md>. Running it means MongoDB plus Redis (AOF) plus API, Worker, WS and Dashboard services. Even a single-VM setup needs 4 vCPU and 8 GB. That is heavy next to Cadence's single SQLite file. Source: <https://docs.novu.co/community/self-hosting-novu/overview>.

### Courier

- **Pricing:** Developer is free with 10,000 sends a month. A send is one template to one recipient, and **sending across several Channels still counts as one send**. Business costs $0.005 per send, and that price applies to the first 10k too. Source: <https://www.courier.com/pricing>. The fetched page said "published Nov 12, 2026". It doesn't list Inbox under Developer. Courier's own blog says in-app messages count toward the same allowance (<https://www.courier.com/blog/best-in-app-notification-centers>, a secondary vendor source).
- **React SDK:** `@trycourier/courier-react` is 9.3.5, modified 2026-11-09, with peers `react >=18`. It wraps the `@trycourier/courier-ui-inbox` web components. The flow is: the backend mints a JWT, the client calls `courier.shared.signIn({ userId, jwt })`, then renders `<CourierInbox />`. The supported states are read, opened and archived. Source: <https://www.courier.com/docs/platform/inbox/inbox-overview>.
- **Auth:** The server calls `POST https://api.courier.com/auth/issue-token` with scopes `user_id:<id> inbox:read:messages inbox:write:events`. Leaving out `expires_in` mints a token that **never expires**, and the SDKs don't refresh tokens. Each token costs an API call, unlike Knock and Novu, which sign locally. Source: <https://www.courier.com/docs/platform/inbox/authentication>.
- **Postmark:** Courier takes our server token and From address. A provider override can set `MessageStream`, and routing can fail over between providers. Source: <https://www.courier.com/docs/external-integrations/email/postmark>.

### MagicBell

- **Pricing:** Builder is free but allows only **1,000 deliveries a month**. Each Channel counts as a delivery, so in-app plus email is 2. Startup is $249 for 50k. Source: <https://www.magicbell.com/pricing>.
- **Email:** The supported providers are Ping Email, SES, Mailgun, SMTP and SendGrid. **Postmark isn't supported**, so email would go through SMTP or another provider. Source: <https://www.magicbell.com/docs/channels/email>.
- **Auth:** An HS256 User JWT signed with the project secret, with claims `user_external_id` and/or `user_email` plus `api_key`. Source: <https://www.magicbell.com/docs/api/authentication/user>.
- **React:** `@magicbell/react` 1.14.0 provides `Inbox` and `FloatingInbox`. The docs page describes read/unread only. Source: <https://www.magicbell.com/docs/libraries/magicbell-react>.
- MagicBell drops out on Postmark support and its free limit.

### SuprSend (alternative)

The free tier allows 10k notifications a month. Inbox is included and branded, and going over gets an alert rather than a shutoff. Essentials costs $100/month. Self-hosting is Enterprise only. The pricing page doesn't mention Postmark, and I didn't check the SDK or auth details. Source: <https://www.suprsend.com/pricing>. It's worth a look only if Knock and Novu both fail.

### Building it in-house

As a baseline, Cadence could store Notifications in a SQLite table and stream them over SSE or polling. That would contradict the map's destination ("a real third-party provider that can also handle other Channels later"), so it's not evaluated here.

## SSR smoke test

On 2026-11-13 we installed `react@19.2.9`, `react-dom@19.2`, `@knocklabs/react@0.15.1`, `@novu/react@3.19.2` and `@trycourier/courier-react@9.3.5` in a scratch project. We then called `renderToString` in Node, with no network:

- **Knock:** `KnockProvider` > `KnockFeedProvider` > `NotificationIconButton` rendered the button markup (1145 chars). It logged a warning about the fake `feedId`.
- **Novu:** `<Inbox applicationIdentifier subscriber>` rendered a visually-hidden placeholder `div`, and the real UI mounts on the client.
- **Courier:** `<CourierInbox />` rendered an empty string, because it's a client-only web component.

None of them crashed on import or render. This test doesn't check full React Router 8 hydration, so the prototype ticket should confirm it in the app.

## Implications for the open questions on the map

- **Identity and auth (Knock):** The recipient id is `String(user.id)`. The root loader signs a token for the session user with `signUserToken`, and `KnockProvider` gets `user={{ id }}` plus `userToken`. The DevUI switches the session user, so the loader re-signs the token. Keying or toggling `enabled` on `KnockProvider` then reconnects the websocket as the new user. Enhanced security can stay off in Knock's development environment.
- **Postmark migration:** With Knock or Courier, Postmark stays as our email provider. The open choice is whether `mailer.server.ts` keeps sending transactional email directly or the provider sends it.
- **Free tier:** Both Knock (10k messages) and Novu (10k runs) cover dev. Novu's 5-workflow cap limits how many Notification types we can model. Knock counts each Channel as a message, so 10k messages is fewer Notifications when they go to both in-app and email.
