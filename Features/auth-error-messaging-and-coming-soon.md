# Implement Landing Auth Error Messaging and "Coming Soon!" Hero Ribbon

Implement this feature exactly as described below.

## Summary
Update the logged-out landing/auth experience so sign-in and sign-up failures show a dedicated inline error inside the auth modal, stay visible until the user retries or closes the modal, and do not rely on the transient global `taskStatusMessage` path. Keep the existing registration gate behavior, but change the blocked-registration copy to the exact requested customer-facing message. Add a polished "Coming Soon!" ribbon integrated into the landing hero near the top.

## Key Changes

### 1. Auth error handling: move to modal-local, persistent messaging
- Add auth-specific UI state in `web/src/public/app.js` for the modal:
  - `authErrorMessage`
  - optional `authErrorCode` if useful for mode-aware formatting
- Render the auth error only inside the active auth panel, not through the global `taskStatusMessage` banner.
- Keep the auth modal open on login/register failure.
- Clear the auth error when:
  - the modal opens
  - the user switches between `register` and `login`
  - the modal closes
  - the relevant input changes
  - auth succeeds
- Do not auto-hide auth errors.

### 2. Standardize auth messages through stable error codes
- Stop depending on raw backend error strings for auth UX.
- Update `server/src/index.js` auth responses to return stable auth codes while preserving current HTTP statuses:
  - register blocked by allowlist: `auth_registration_closed` with `403`
  - missing email on login/register: `auth_email_required` with `400`
  - invalid login: `auth_invalid_credentials` with `401`
- In `web/src/public/app.js`, add auth-specific message formatting similar to the existing plan-error formatter.
- Exact user-facing copy:
  - `auth_registration_closed`:
    - `Sorry, customer registration is not yet open. We will let you know when it is and we hope to see you again soon!`
  - `auth_email_required`:
    - `Please enter your email address.`
  - `auth_invalid_credentials`:
    - `Invalid email or password.`
  - unknown auth/network/request failures:
    - `Something went wrong. Please try again.`
- Limit this formatter to auth flows only; leave the rest of the app's current error handling unchanged.

### 3. Landing page "Coming Soon!" hero ribbon
- Add a new ribbon/banner element in the logged-out landing hero in `web/src/public/app.js`, positioned near the top of hero content, directly below the eyebrow copy.
- Banner text is exactly:
  - `Coming Soon!`
- Style it in `web/src/public/styles.css` as a professional hero-integrated ribbon:
  - compact glass/surface treatment that matches the existing neon-dark landing palette
  - subtle border, soft shadow, strong typography
  - no loud animation
  - responsive on mobile without wrapping awkwardly or pushing the hero off balance
- This banner is informational only; it does not replace or disable existing auth CTA buttons.

### 4. Scope boundaries
- Keep current registration gating logic based on `DEMO_USERS`; only change the error contract/copy.
- Do not change signup/login business logic beyond auth error response codes/messages and how the UI renders them.
- Do not route auth failures into `taskStatusMessage` anymore on the landing page.
- Do not change authenticated app pages; this work is for the logged-out landing/auth experience.

## Test Plan
- Manual browser validation on the logged-out landing page:
  - open Register modal with a non-allowlisted email and confirm the modal stays open and shows the exact requested copy inline
  - open Log in modal with invalid credentials and confirm inline `Invalid email or password.`
  - submit login/register with empty email and confirm inline `Please enter your email address.`
  - simulate a generic failure/network failure and confirm inline fallback `Something went wrong. Please try again.`
  - confirm switching between Login/Register clears the prior auth error
  - confirm closing and reopening the modal clears the prior auth error
  - confirm successful login/register still closes the modal and proceeds normally
  - confirm no transient global landing status banner appears for auth failures
  - confirm the new `Coming Soon!` ribbon is visible near the top of the hero on desktop and mobile and remains visually aligned with the existing landing design

## Assumptions and Defaults
- "Home page" means the logged-out landing page rendered by `renderAuth()`.
- "Standard" auth messaging means polished, user-facing frontend copy mapped from stable auth error codes, not raw backend strings.
- The only exact required custom copy is the registration-closed message above; all other auth failures use the standard messages listed in this plan.
- Existing register behavior for already-existing emails is left unchanged for this pass; this plan only fixes messaging/presentation, not broader auth semantics.
