// src/index.js

// Map your Supabase "tier/plan" to OWUI group NAMES (server resolves names → IDs)
const PLAN_GROUP_MAP = {
	free: 'Student',
	standard: 'Standard',
	pro: 'Pro',
};

export default {
	// Manual trigger: GET /cron (helpful for testing)
	async fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);

		if (request.method === 'POST') {
			// Keep your webhook path if you use it (optional)
			return handleWebhook(request, env);
		}

		if (pathname === '/cron') {
			try {
				const summary = await runSync(env);
				return json(200, summary);
			} catch (err) {
				return text(500, `cron error: ${err.message}`);
			}
		}

		return text(404, 'Not found');
	},

	// Cron trigger: runs every minute per wrangler.jsonc
	async scheduled(event, env, ctx) {
		ctx.waitUntil(
			(async () => {
				try {
					const summary = await runSync(env);
					console.log('cron summary', summary);
				} catch (err) {
					console.error('cron error', err.message);
				}
			})(),
		);
	},
};

// -------- Core sync --------

async function runSync(env) {
	const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
	if (!env.SUPABASE_URL || !sbKey) {
		throw new Error('Missing SUPABASE_URL or service role key');
	}
	if (!env.OWUI_SYNC_ENDPOINT || !env.OWUI_AUTH_TOKEN) {
		throw new Error('Missing OWUI_SYNC_ENDPOINT or OWUI_AUTH_TOKEN');
	}

	const supaUsers = await fetchJSON(`${env.SUPABASE_URL}/rest/v1/billing_users?select=email,tier`, {
		headers: {
			apikey: sbKey,
			Authorization: `Bearer ${sbKey}`,
			Prefer: 'count=exact',
		},
	});

	if (!Array.isArray(supaUsers) || supaUsers.length === 0) {
		return { fetched: 0, posted: 0, created: 0, updated: 0, failed: 0, note: 'no users' };
	}

	const users = supaUsers
		.map((u) => {
			const email = String(u.email || '')
				.trim()
				.toLowerCase();
			if (!email) return null;
			const tier = String(u.tier || 'free')
				.trim()
				.toLowerCase();
			const group = PLAN_GROUP_MAP[tier] || PLAN_GROUP_MAP.free;
			return {
				email,
				name: email.split('@')[0],
				role: 'user',
				group,
			};
		})
		.filter(Boolean);

	if (users.length === 0) {
		return { fetched: supaUsers.length, posted: 0, created: 0, updated: 0, failed: 0, note: 'no valid emails' };
	}

	const res = await fetch(env.OWUI_SYNC_ENDPOINT, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'X-API-KEY': env.OWUI_AUTH_TOKEN, // ✅ now using X-API-KEY
		},
		body: JSON.stringify({ users }),
	});

	const txt = await res.text();
	if (!res.ok) throw new Error(`OWUI POST ${res.status}: ${txt}`);

	let parsed;
	try {
		parsed = JSON.parse(txt);
	} catch {
		parsed = { raw: txt };
	}

	return {
		fetched: supaUsers.length,
		received: parsed.received ?? users.length,
		created: parsed.created ?? 0,
		updated: parsed.updated ?? 0,
		failed: parsed.failed ?? 0,
		results: parsed.results ?? undefined,
	};
}

// -------- Optional webhook --------

async function handleWebhook(request, env) {
	const raw = await request.text();
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		return text(400, 'Invalid JSON');
	}

	const event = body?.meta?.event_name;
	if (!['subscription_created', 'subscription_updated'].includes(event)) {
		return text(200, 'ignored');
	}

	const attrs = body?.data?.attributes || {};
	const email = (attrs.user_email || '').trim().toLowerCase();
	const name = attrs.user_name || (email ? email.split('@')[0] : 'Unknown');

	if (!email) return text(400, 'Missing email');

	// Determine tier based on Lemon Squeezy variant ID
	const variantId = String(attrs.variant_id || '');
	let tier = 'free';
	if (variantId === String(env.STUDENT_VARIANT_ID)) tier = 'student';
	if (variantId === String(env.STANDARD_VARIANT_ID)) tier = 'standard';
	if (variantId === String(env.PRO_VARIANT_ID)) tier = 'pro';

	const lemon_customer_id = attrs.customer_id || null;
	const lemon_subscription_id = body?.data?.id || null;
	const status = attrs.status || null;

        const sbKey = env.SUPABASE_SERVICE_KEY;
        if (!env.SUPABASE_URL || !sbKey) {
                return text(500, 'Missing Supabase config');
        }
        // Upsert into billing_users and return the stored row
        const [row] = await fetchJSON(`${env.SUPABASE_URL}/rest/v1/billing_users?on_conflict=email`, {
                method: 'POST',
                headers: {
                        apikey: sbKey,
                        Authorization: `Bearer ${sbKey}`,
                        'content-type': 'application/json',
                        Prefer: 'resolution=merge-duplicates,return=representation',
                },
                body: JSON.stringify([{ email, tier, lemon_customer_id, lemon_subscription_id, status }]),
        });

        // Optionally create a Supabase Auth user (ignore errors)
        try {
                await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
                        method: 'POST',
                        headers: {
                                apikey: sbKey,
                                Authorization: `Bearer ${sbKey}`,
                                'content-type': 'application/json',
                        },
                        body: JSON.stringify({ email, email_confirm: true }),
                });
        } catch (err) {
                console.warn('auth create err', err?.message);
        }

        // Send invite email so the user can set a password (ignore failures)
        try {
                const inviteRes = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/invite`, {
                        method: 'POST',
                        headers: {
                                apikey: sbKey,
                                Authorization: `Bearer ${sbKey}`,
                                'content-type': 'application/json',
                        },
                        body: JSON.stringify({
                                email,
                                redirect_to: 'https://chat.prosperspot.com', // optional redirect after they click
                        }),
                });
                if (!inviteRes.ok) {
                        const errText = await inviteRes.text();
                        console.warn('Failed to send invite email', inviteRes.status, errText);
                }
        } catch (err) {
                console.warn('Invite request failed', err.message);
        }

	// Use tier from row to determine OWUI group
	const group = PLAN_GROUP_MAP[row?.tier] || PLAN_GROUP_MAP.free;

	const payload = [{ email, name, role: 'user', group }];

	const res = await fetch(env.OWUI_SYNC_ENDPOINT, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'X-API-KEY': env.OWUI_AUTH_TOKEN, // ✅ also here
		},
		body: JSON.stringify({ users: payload }),
	});

	const txt = await res.text();
	const ok = res.ok ? 'OK' : `ERR ${res.status}`;
	return text(res.ok ? 200 : 500, `Webhook ${ok}\n${txt}`);
}

// -------- tiny helpers --------
async function fetchJSON(url, init) {
	const r = await fetch(url, init);
	if (!r.ok) {
		const t = await r.text().catch(() => '');
		throw new Error(`${url} -> ${r.status} ${t}`);
	}
	return r.json();
}

function json(status, obj) {
	return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function text(status, s) {
	return new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
