/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
export interface Env {
	// If you set another name in the Wrangler config file for the value for 'binding',
	// replace "DB" with the variable name you defined.
	DB: D1Database;
}

interface Candidate {
    email: string;
    name?: string;
    gender?: string;
    jobTitle?: string;
    cv?: string;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Handle CORS preflight requests
		if (request.method === "OPTIONS") {
			return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Origin",
			}
			});
		}
		const url = new URL(request.url);
		
		let body;
		try {
			body = await request.json();
		} catch (e) {
			return new Response('Invalid JSON', { status: 400 });
		}

		const { token } = body as { token?: string };

		if (!token) {
			return new Response('Token is required', { status: 400 });
		}

		const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
		if (!response.ok) {
		const errorText = await response.text();
		console.error(`Token verification failed for token ${token}`, response.status, errorText);
			return new Response('invalid_token', { status: 400 });
		}

		const payload = await response.json();

		const email = payload['email'] as string;

        if (url.pathname === "/" && request.method === "POST") {
            return getForEmail(email, env);
        }

		if (url.pathname === "/update" && request.method === "POST") {
			const { candidate } = body as { candidate?: Partial<Candidate>  };

			if (!candidate) {
				return new Response('Candidate is required', { status: 400 });
			}
            return updateCandidate(candidate, env);
        }

        return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function updateCandidate(candidate:Partial<Candidate>, env:Env) {
    console.log(`Updating candidate data with email ${candidate.email}`);
    try {
        // Check if the user exists
        const existingUser = await env.DB.prepare(
            'SELECT * FROM candidate WHERE candidate_email = ?'
        ).bind(candidate.email).first();

        if (!existingUser) {
            return new Response(`No user found with email ${candidate.email}`, {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                },
            });
        }

        // Update user details
        await env.DB.prepare(
            `UPDATE candidate SET name = ?, gender = ?, job_title = ?, cv = ? WHERE candidate_email = ?`
        )
        .bind(candidate.name, candidate.gender, candidate.jobTitle, candidate.cv, candidate.email)
        .run();

        // Retrieve updated candidate
        const updatedCandidate = await env.DB.prepare(
            'SELECT * FROM candidate WHERE candidate_email = ?'
        ).bind(candidate.email).first();

        return new Response(
            JSON.stringify({ message: "Candidate updated successfully", candidate: updatedCandidate }),
            {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                },
            }
        );
    } catch (error) {
        console.error(`Error updating user with email ${candidate.email}`, error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }
}


async function getForEmail(email:string, env:Env) : Promise<Response> {
	console.log(`Retrieving candidate data with email ${email}`);
	try{
		// Check if user exists in the database
		const existingUser = await env.DB.prepare(
			'SELECT * FROM candidate WHERE candidate_email = ?'
			).bind(email).first();
		
		if(!existingUser){
			return new Response(`No user found with email ${email}`, 
				{   status: 400, 
					headers: { 
					"Content-Type": "application/json", 
					"Access-Control-Allow-Origin": "*", // Allow all origins
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS", // Allow specific HTTP methods
					}});
		}else{
			return new Response(
				JSON.stringify({
					id: existingUser.candidate_id, 
					email: existingUser.email,
					name: existingUser.name,
					gender: existingUser.gender,
					jobTitle: existingUser.job_title,
					cv: existingUser.cv
				}),
				{   status: 200, 
					headers: { 
					"Content-Type": "application/json", 
					"Access-Control-Allow-Origin": "*", // Allow all origins
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS", // Allow specific HTTP methods
				}}
			);
		}
	}catch(error){
		console.log(`Error fetching user with email ${email}`, error);
		return new Response(JSON.stringify({ error: error}), {
			status: 500,
			headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
			});
	}
}
