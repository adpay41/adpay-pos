# Finix — reference links and environment notes

Everything here is from Finix's public documentation (verified 2026-09-23). No credentials appear
in this file and none ever should. Real keys live in AWS (`/adpay/dev/finix`) and GitHub Actions
secrets.

> **Account status:** Finix is **not signed yet** (spec, Context → Processor). The payment layer is
> built behind the `PaymentProvider` interface with a stub adapter (ADR 0003); the Finix adapter is
> sequencing step 6.

## Environments

| Environment | Base URL |
| --- | --- |
| Sandbox | `https://finix.sandbox-payments-api.com` |
| Live | `https://finix.live-payments-api.com` |

- The two environments are **entirely separate** and do **not** share API credentials.
- Auth is **HTTP Basic** with a `username:password` pair from the Dashboard — Finix calls it an
  "API key"; it is a pair, so `.env.example` carries both `FINIX_API_KEY` and `FINIX_API_SECRET`.
- Requests pin an API version with the `Finix-Version` header (docs show `2022-02-01`). Pin it
  explicitly in the adapter rather than defaulting.
- Live access is granted by a Finix contact, not self-serve.

## Dashboard

- Login: <https://finix.payments-dashboard.com/Login>
- Sandbox sign-up: <https://finix.payments-dashboard.com/signup>
- **API key**: Dashboard → **Developer** → **Create API Key**. The username/password are shown
  **once** — they cannot be retrieved after the window closes.
- **Application ID and Merchant ID**: Dashboard → **Developer** → *Finix Processing Details*.

### Open: confirm the dashboard type is *Software Platform*

Not yet confirmed — the sandbox dashboard was at a login screen rather than an active session when
this bootstrap ran. Finix's "Platform Payments" guide is the relevant path for a software platform
that onboards its own merchants: <https://docs.finix.com/guides/platform-payments>

## The pages that matter for this build

| Topic | Link |
| --- | --- |
| Docs home | <https://docs.finix.com/> |
| Getting started | <https://docs.finix.com/guides/getting-started> |
| Set up dev environment (auth, base URLs, IDs) | <https://docs.finix.com/guides/getting-started/set-up-developer-environment> |
| API keys | <https://docs.finix.com/additional-resources/developers/authentication-and-api-basics/api-keys> |
| **In-person payments (card-present)** | <https://docs.finix.com/guides/in-person-payments> |
| Select your device | <https://docs.finix.com/guides/in-person-payments/select-your-device> |
| **PAX A35** | <https://docs.finix.com/guides/in-person-payments/select-your-device/pax-a35> |
| Choosing an integration path | <https://docs.finix.com/guides/in-person-payments/building-your-integration> |
| Devices API reference (activate / update / monitor terminals) | <https://docs.finix.com/guides/in-person-payments> → *Device API Reference* |
| Online payments / tokenization (hosted fields) | <https://docs.finix.com/guides/online-payments> |
| **Onboarding / Identities** (merchant onboarding) | <https://docs.finix.com/guides/platform-payments> |
| After the payment (refunds, disputes, receipts) | <https://docs.finix.com/guides/after-the-payment> |
| **Payouts / settlements** | <https://docs.finix.com/guides/after-the-payment/payouts> |
| Managing operations (incl. webhooks) | <https://docs.finix.com/guides/managing-operations> |
| Release notes — watch for breaking changes | <https://docs.finix.com/release-notes> |
| Key resources (object model) | <https://docs.finix.com/additional-resources/developers/resources-and-payment-flows/key-resources> |
| Sample "accept a payment" app | <https://github.com/finix-payments/accept-a-payment> |
| Support | <support@finix.com> |

Every docs page has a `.md` twin — append `.md` to the URL (e.g.
`https://docs.finix.com/guides/getting-started.md`) for a clean version to read or diff.

## Terminals — the A35 is supported

From *Select Your Device*, confirming the hardware choice in the spec:

| Terminal | Use case | Integration | Connectivity | Power | Countries |
| --- | --- | --- | --- | --- | --- |
| **PAX A35** | Compact Android smart PIN pad for retail checkout; countertop and multilane POS | **API**, Device Reader SDK | **Wi-Fi, Ethernet** | Plug-in | U.S. and Canada |

That matches the spec exactly: a separate A35 on the store LAN, driven over the API, with the
register never touching card data. Ethernet support matters — these stores are noisy on Wi-Fi.

Other supported devices, for context: PAX A800 and A920 Pro (both with embedded printers, so a
future single-device configuration is possible), PAX A3700 (customer-facing tablet), PAX IM30
(unattended), PAX D135 (Bluetooth, SDK only), and Tap to Pay on iPhone.

Note also **Deploy Apps to Your Terminals** — the Device Reader SDK runs your own Android app
directly on PAX terminals. Not v1, but it is the fallback if the dual-screen register plus separate
A35 ever proves awkward.

## Getting a test terminal

There is no self-serve "request a test terminal" button. Per the docs: order in **Production** via
the **Device Store** in the Finix Dashboard, or **reach out to your Finix contact to order a
terminal for Sandbox**. So a sandbox A35 is a conversation with Finix, not a checkout — worth
starting early, since the terminal adapter is sequencing step 6 and the A35's arrival gates it.

For integration testing before hardware arrives, see *Testing Your Integration* under In-Person
Payments (Sandbox test cards and approved test amounts), and keep using the stub provider.

## Webhooks

Under *Managing Operations*. Two things to settle when the adapter is built:

- Signature verification — the secret belongs in `FINIX_WEBHOOK_SECRET`, never in the repo.
- Sandbox and Live are separate; webhook endpoints must be registered per environment.
