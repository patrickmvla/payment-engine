# Glossary — Every Term, Defined

Quick reference for every financial and technical term used in this project.
Organized alphabetically.

---

## Financial Terms

**Account**
A named bucket where money is tracked. In double-entry bookkeeping, every
financial event moves money between accounts. Examples: `customer_funds`,
`merchant_payable`, `platform_fees`.

**ACID**
Atomicity, Consistency, Isolation, Durability. Four guarantees provided by
PostgreSQL that ensure database transactions are reliable. Critical for
financial data where partial operations would corrupt money records.

**Amortization**
Spreading a payment over multiple periods (e.g., loan repayments). Not
implemented in this project, but a common fintech concept.

**APR (Annual Percentage Rate)**
The yearly interest rate charged on a loan. Not implemented here.

**Asset (Account Type)**
Something of value that you own or control. In our system, `customer_holds` and
`platform_cash` are asset accounts. Assets increase with debits.

**Authorization**
The first step in a payment. The customer's funds are verified and held
(reserved) but not yet transferred. The hold typically expires after 7 days if
not captured.

**Audit Trail**
A chronological record of every change in the system. Our immutable ledger
entries form the audit trail — every financial event is recorded and cannot be
modified or deleted.

**Balance**
The current amount in an account, computed from the sum of all ledger entries.
For asset accounts: `SUM(debits) - SUM(credits)`. For liability accounts:
`SUM(credits) - SUM(debits)`. Never stored directly — always derived.

**Capture**
Converting an authorization into an actual charge. The held funds are
transferred from the customer to the merchant. Can be full or partial.

**Chargeback**
When a customer disputes a charge with their bank and the bank forcibly reverses
it. Not implemented in v1, but a critical concept in real payment systems.

**Chart of Accounts**
The complete list of accounts in the system. Defines where money can sit and
how it's categorized (assets, liabilities, revenue, expenses).

**Credit**
One side of a double-entry. Increases liability, revenue, and equity accounts.
Decreases asset and expense accounts. In our system, stored as
`direction: "CREDIT"` with a positive amount.

**Debit**
The other side of a double-entry. Increases asset and expense accounts.
Decreases liability, revenue, and equity accounts. In our system, stored as
`direction: "DEBIT"` with a positive amount.

**Double-Entry Bookkeeping**
An accounting system where every financial event is recorded in at least two
accounts — a debit and a credit — that must always balance. Invented in the
1400s, still the foundation of all financial systems.

**Expense (Account Type)**
Money spent on operations. Increases with debits. Not heavily used in our v1
system.

**Hold**
See Authorization. Funds that are reserved but not yet charged.

**Idempotency**
The property that performing the same operation multiple times produces the same
result as performing it once. Critical for payment systems where network retries
could otherwise create duplicate charges.

**ISO 4217**
The international standard for currency codes. Three-letter codes: `USD`
(US Dollar), `EUR` (Euro), `GBP` (British Pound), `JPY` (Japanese Yen).

**KYC (Know Your Customer)**
Identity verification processes required by financial regulations. Not
implemented in this project.

**Ledger**
The authoritative record of all financial transactions. In our system, the
ledger is composed of `ledger_transactions` and `ledger_entries` tables. It is
the source of truth for all money in the system.

**Liability (Account Type)**
Money that you owe to someone else. `customer_funds` (money customers deposited
with us) and `merchant_payable` (money we owe merchants) are liabilities.
Liabilities increase with credits.

**PCI-DSS**
Payment Card Industry Data Security Standard. Compliance requirements for
handling credit card data. We don't handle real card data in this project.

**Partial Capture**
Capturing less than the full authorized amount. Example: auth for $100, capture
only $70 because one item was out of stock.

**Partial Refund**
Refunding less than the full captured amount. Example: captured $100, refund $30
for one returned item. Multiple partial refunds are allowed up to the captured
amount.

**Reconciliation**
Comparing records from different sources (e.g., your ledger vs a bank statement)
to ensure they agree. The immutable ledger makes reconciliation possible.

**Refund**
Returning money to a customer after a capture. Can be full or partial. Creates
reversing ledger entries.

**Revenue (Account Type)**
Money earned by the business. `platform_fees` is a revenue account. Revenue
increases with credits.

**Settlement**
The final transfer of money to the merchant's bank account. Typically batched
at end-of-day. In our v1, modeled as a status change rather than actual bank
transfer.

**Void**
Canceling an authorization before capture. Releases the held funds immediately.
A voided payment is in a terminal state — no further actions are possible.

---

## Technical Terms

**BigInt**
A JavaScript/TypeScript numeric type that can represent arbitrarily large
integers without precision loss. Used for all money amounts to avoid floating
point errors.

**Bun**
A JavaScript/TypeScript runtime, alternative to Node.js. Faster startup, built-in
TypeScript support, built-in test runner, native Web APIs.

**CUID2**
A collision-resistant unique identifier. We use it (or ULID) for generating
IDs that are unique, time-sortable, and URL-safe.

**Cursor Pagination**
A pagination strategy where the client provides the ID of the last seen item
to get the next page. More stable than offset pagination for data that changes
frequently.

**Drizzle ORM**
A lightweight, type-safe SQL query builder for TypeScript. Generates
parameterized queries, provides compile-time type checking, and includes a
migration tool.

**God Check**
The system-wide invariant verification that `SUM(debits) === SUM(credits)`
across all ledger entries. If this check fails, money was created or destroyed.
The ultimate proof of ledger integrity. Run after every test flow.

**Hono**
A lightweight HTTP framework designed for edge runtimes and Bun. Minimal
footprint (~14kb), middleware-based, with built-in Zod validation support.

**Hono RPC**
A type-safe HTTP client generated from Hono routes via the `hc()` helper.
Provides compile-time checking of request bodies, URL params, headers, and
response types. Used for E2E testing with real HTTP against a running server,
giving true end-to-end coverage with full type safety.

**Idempotency Key**
A unique string sent by the client with each request. If the same key is seen
again, the server returns the cached response instead of processing the request
again. Prevents duplicate operations from network retries.

**Invariant**
A condition that must always be true in the system. Example: "total debits must
equal total credits for every transaction." If an invariant is violated, the
system is in a corrupt state.

**Mass Assignment**
An attack where a client sends fields in a request body that the server
doesn't expect (e.g., `{ "status": "captured" }` to bypass the state machine).
Prevented by Zod schema validation, which acts as an allowlist — only declared
fields are accepted, everything else is stripped.

**Migration**
A versioned SQL script that modifies the database schema (creates tables, adds
columns, etc.). Managed by Drizzle Kit. Forward-only — no down migrations.

**Middleware**
A function that runs before or after a route handler. Used for cross-cutting
concerns: logging, idempotency checking, error handling, rate limiting.

**Offset Pagination**
A pagination strategy using `page` and `per_page` parameters. Breaks when
records are inserted between page requests. Not used in this project.

**OpenAPI**
A specification for describing REST APIs. Version 3.1 is the latest. Our spec
is generated automatically from Zod schemas via `@hono/zod-openapi`.

**OpenAPIHono**
The Hono router extended with OpenAPI capabilities. Routes defined with
`createRoute()` automatically contribute to the OpenAPI spec.

**Parameterized Query**
A SQL query where user-provided values are passed as separate parameters, not
interpolated into the SQL string. Prevents SQL injection. Drizzle uses this
by default.

**Prepared Statement**
A pre-compiled SQL query stored on the database server. Faster on repeated
execution (no re-parsing) and inherently prevents SQL injection. Enabled via
the `prepare: true` option in the postgres.js driver. Only works with direct
PostgreSQL connections — PgBouncer in transaction mode does not support them.

**Pessimistic Locking**
A concurrency strategy where a database row is locked before modification.
Other transactions must wait. Used via `SELECT ... FOR UPDATE` to prevent
concurrent mutations on the same payment.

**Optimistic Locking**
A concurrency strategy where modifications include a version check. If the
version changed since reading, the operation fails and retries. Not used in
this project — pessimistic locking is safer for financial data.

**Scalar**
A modern API documentation UI, alternative to Swagger UI. Renders OpenAPI
specs as interactive, browseable documentation with try-it-out functionality.

**State Machine**
A model where a system can be in one of a finite number of states, and
transitions between states follow strict rules. Payments follow a state
machine: `created → authorized → captured → settled`.

**Terminal State**
A state from which no further transitions are possible. In our system:
`voided`, `expired`, and `refunded` are terminal states.

**Token Bucket**
A rate limiting algorithm. Clients have a "bucket" of tokens that refills over
time. Each request consumes a token. When the bucket is empty, requests are
rejected (429).

**ULID (Universally Unique Lexicographically Sortable Identifier)**
A 26-character identifier that encodes a timestamp and random component.
Time-sortable (unlike UUID), URL-safe, and globally unique.

**Zod**
A TypeScript-first schema validation library. Defines the shape of data,
validates at runtime, and infers TypeScript types. With the OpenAPI extension,
also generates API documentation.

---

## Acronyms

| Acronym | Full Form |
|---|---|
| ACID | Atomicity, Consistency, Isolation, Durability |
| AML | Anti-Money Laundering |
| API | Application Programming Interface |
| APR | Annual Percentage Rate |
| CRUD | Create, Read, Update, Delete |
| DI | Dependency Injection |
| FK | Foreign Key |
| GDPR | General Data Protection Regulation |
| HMAC | Hash-based Message Authentication Code |
| HTTP | Hypertext Transfer Protocol |
| ISO | International Organization for Standardization |
| JSON | JavaScript Object Notation |
| JSONB | JSON Binary (PostgreSQL's optimized JSON storage) |
| JWT | JSON Web Token |
| KYC | Know Your Customer |
| ORM | Object-Relational Mapping |
| OWASP | Open Web Application Security Project |
| PCI-DSS | Payment Card Industry Data Security Standard |
| PEP | Politically Exposed Person |
| PII | Personally Identifiable Information |
| PK | Primary Key |
| REST | Representational State Transfer |
| SOC 2 | Service Organization Control Type 2 |
| SQL | Structured Query Language |
| SSRF | Server-Side Request Forgery |
| TLS | Transport Layer Security |
| TTL | Time To Live |
| ULID | Universally Unique Lexicographically Sortable Identifier |
| UUID | Universally Unique Identifier |
| WAF | Web Application Firewall |
| XSS | Cross-Site Scripting |

---

Previous: [11 — Development Guide](./11-development-guide.md) | Next: [13 — Database Connection Strategy](./13-database-connection-strategy.md)
