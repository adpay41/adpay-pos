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

### Dashboard type — Software Platform, confirmed

The sandbox dashboard is a **platform** dashboard, not a single-merchant one. The navigation carries
**Merchant Identities, Merchant Payouts, Onboarding Forms, Compliance Forms** and an
**Application** resource — Finix describes the Application as *"your own business or platform within
the Finix system"* — and the API keys issued are **Application**-scoped with the **Developer** role.
That is the Software Platform / PayFac-as-a-Service shape the spec assumes, where AD Pay onboards
its own merchants.

The account is **Sandbox** and **not activated** ("Looking to Activate Your Account?"). Live access
is a conversation with Finix.

### ⚠️ Entity mismatch — decided, with migration debt

The sandbox account is registered to **AmericanDream11 LLC** (`team@americandream11.us`), not
**American Dream Pay LLC**. The bootstrap rule is that AD Pay is a separate company from AD11, and a
processor account is bound to a legal entity for underwriting, settlement and liability.

**Decision (2026-09-23): build v1 against this sandbox, migrate to an American Dream Pay LLC
account before going live.** See **[ADR 0006](decisions/0006-finix-sandbox-entity-migration.md)**
for what that costs and what must change first — it is a production release blocker, not a backlog
item. The Application ID (`AP8CpWQcq7CiSMyRDCVuuqE6`) and the Merchant / Identity IDs are in the
AWS parameter `/adpay/dev/finix`, tagged with the owning entity. No AD11 identifier is committed to
this repository.

Two Application-scoped API keys already exist in that account (created 2026-09-10, one used
2026-09-22). No new key was created here.

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

## Getting a test terminal — confirmed, you cannot self-serve

The Device Store is present in the dashboard, but in Sandbox it says plainly:

> You are not able to order devices in Sandbox, please contact your Finix point of contact or
> support@finix.com if you would like to purchase devices.

So a sandbox A35 is a conversation with Finix, not a checkout. **Start it early** — the terminal
adapter is sequencing step 6 and the A35's arrival gates it.

Device Store list prices (sandbox catalogue, USD):

| Device | Price |
| --- | --- |
| **PAX A35** (the one v1 targets) | **$282.00** |
| PAX D135 | $75.00 |
| PAX A800 | $400.00 |
| PAX A920 Pro | $500.00 |
| PAX A3700 | $550.00 |
| PAX IM30 | $590.00 |

The dashboard also has **Device Management** and **Device Orders** pages, which is where terminal
health and fulfilment will show up once real hardware exists.

Until hardware arrives, test with *Testing Your Integration* under In-Person Payments (Sandbox test
cards and approved test amounts) and keep the stub provider.

## Webhooks

Under *Managing Operations*. Two things to settle when the adapter is built:

- Signature verification — the secret belongs in `FINIX_WEBHOOK_SECRET`, never in the repo.
- Sandbox and Live are separate; webhook endpoints must be registered per environment.
