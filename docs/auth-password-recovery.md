# Supabase password recovery

Customer-facing recovery links use the dedicated `/auth/reset-password` route. Configure these Supabase Auth redirect URLs:

- `https://tickets.gruposantino.com.mx/auth/reset-password`
- `http://localhost:3000/auth/reset-password`

For new recovery emails, use Supabase's recovery token hash in the email template so the application can verify it without exposing an access or refresh token in server logs:

```html
<a href="{{ .SiteURL }}/auth/reset-password?token_hash={{ .TokenHash }}&type=recovery">Establecer nueva contraseña</a>
```

The route also accepts Supabase's current implicit recovery redirect. A client-only bridge detects only `type=recovery`, moves the unchanged fragment to the dedicated route, and lets the Supabase browser client consume it. Application code never logs or manually stores access or refresh tokens.

After deploying this change and updating the template, discard previously exposed recovery URLs and send a fresh recovery email. Completing a successful password update invalidates the recovery link for reuse. If a prior recovery session was opened on a shared device, sign it out and clear that browser's site data before testing the new link.
