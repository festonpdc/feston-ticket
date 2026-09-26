# Supabase password recovery

Customer-facing recovery links use the dedicated `/auth/reset-password` route. Configure these Supabase Auth redirect URLs:

- `https://tickets.gruposantino.com.mx/auth/reset-password`
- `http://localhost:3000/auth/reset-password`

Supabase's default recovery email uses an implicit fragment. The route consumes that fragment through the official `auth.setSession` API, clears it from the address bar before awaiting the result, and enables the password form only after the SDK returns a valid session. Custom SMTP is not required.

If a custom email template is introduced later, prefer Supabase's recovery token hash so the application can verify it without putting access or refresh tokens in the URL:

```html
<a href="{{ .SiteURL }}/auth/reset-password?token_hash={{ .TokenHash }}&type=recovery">Establecer nueva contraseña</a>
```

The global client-only bridge handles legacy redirects that land on another application route. It detects only `type=recovery` and moves the unchanged fragment to the dedicated route. Application code never logs the tokens or stores them outside the Supabase SDK's normal session storage.

After deploying this change, discard previously exposed recovery URLs and send a fresh recovery email from the existing default flow. No custom template or SMTP change is required. Completing a successful password update invalidates the recovery link for reuse. If a prior recovery session was opened on a shared device, sign it out and clear that browser's site data before testing the new link.
