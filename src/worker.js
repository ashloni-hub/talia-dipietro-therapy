const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND_URL = 'https://api.resend.com/emails';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/contact' && request.method === 'POST') {
      return handleContact(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleContact(request, env, ctx) {
  const origin = new URL(request.url).origin;
  const fail = () => Response.redirect(`${origin}/contact.html?error=1#reach`, 303);

  let formData;
  try {
    formData = await request.formData();
  } catch (err) {
    console.error('[contact] failed to parse form data', err);
    return fail();
  }

  // Honeypot: if filled in, pretend success and send nothing.
  const honeypot = (formData.get('website') || '').toString().trim();
  if (honeypot) {
    console.error('[contact] honeypot triggered, dropping submission silently');
    return Response.redirect(`${origin}/thank-you.html`, 303);
  }

  const name = (formData.get('name') || '').toString().trim();
  const email = (formData.get('email') || '').toString().trim();
  const phone = (formData.get('phone') || '').toString().trim();
  const message = (formData.get('message') || '').toString().trim();
  const turnstileToken = (formData.get('cf-turnstile-response') || '').toString();

  if (!name || !email || !message) {
    console.error('[contact] missing required field(s)', {
      hasName: Boolean(name),
      hasEmail: Boolean(email),
      hasMessage: Boolean(message),
    });
    return fail();
  }

  if (!env.TURNSTILE_SECRET_KEY) {
    console.error('[contact] TURNSTILE_SECRET_KEY is not set in the environment');
    return fail();
  }

  let turnstileResult;
  try {
    const turnstileResponse = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: turnstileToken,
        remoteip: request.headers.get('CF-Connecting-IP') || '',
      }),
    });
    turnstileResult = await turnstileResponse.json();
  } catch (err) {
    console.error('[contact] turnstile verification request threw', err);
    return fail();
  }

  if (!turnstileResult.success) {
    console.error('[contact] turnstile verification failed', turnstileResult);
    return fail();
  }

  if (!env.RESEND_API_KEY) {
    console.error('[contact] RESEND_API_KEY is not set in the environment');
    return fail();
  }
  if (!env.CONTACT_TO_EMAIL || !env.CONTACT_FROM_EMAIL) {
    console.error('[contact] CONTACT_TO_EMAIL or CONTACT_FROM_EMAIL is not set', {
      hasTo: Boolean(env.CONTACT_TO_EMAIL),
      hasFrom: Boolean(env.CONTACT_FROM_EMAIL),
    });
    return fail();
  }

  let notifyResponse;
  try {
    notifyResponse = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.CONTACT_FROM_EMAIL,
        to: env.CONTACT_TO_EMAIL,
        reply_to: email,
        subject: `New inquiry from ${name}`,
        text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone || '(not provided)'}\n\nMessage:\n${message}`,
      }),
    });
  } catch (err) {
    console.error('[contact] resend notification request threw', err);
    return fail();
  }

  if (!notifyResponse.ok) {
    const errText = await notifyResponse.text();
    console.error('[contact] resend API error on notification email', notifyResponse.status, errText);
    return fail();
  }

  // Auto-reply to the visitor. Fired in the background so it never delays the redirect.
  ctx.waitUntil(
    (async () => {
      try {
        const autoReplyResponse = await fetch(RESEND_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: env.CONTACT_FROM_EMAIL,
            to: email,
            subject: 'Thanks for reaching out to Talia DiPietro Therapy',
            text: `Hi ${name},\n\nThank you for reaching out! I will get back to you within 1 business day.\n\nIf this is urgent, this form is not a crisis line. Call or text 988 to reach the Suicide and Crisis Lifeline, or call 911.\n\nTalia`,
          }),
        });
        if (!autoReplyResponse.ok) {
          const errText = await autoReplyResponse.text();
          console.error('[contact] resend API error on auto-reply email', autoReplyResponse.status, errText);
        }
      } catch (err) {
        console.error('[contact] auto-reply send threw', err);
      }
    })()
  );

  return Response.redirect(`${origin}/thank-you.html`, 303);
}
