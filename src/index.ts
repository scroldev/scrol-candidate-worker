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
	photo_storage: R2Bucket;
}

interface Candidate {
    email: string;
    name?: string;
    gender?: string;
    jobTitle?: string;
    cv?: string;
	photo?:string;
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

		if (url.pathname === "/updatepicture" && request.method === "POST"){
			return updatePicture(email, env, request);
		}
		
		if (url.pathname === "/getpicture" && request.method === "POST"){
			return getPicture(email, env);
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

async function getPicture(email: string, env:Env):Promise<Response>{
    console.log(`Fetching candidate photo with email ${email}`);
	try{
		// Check if the user exists
		const existingUser = await env.DB.prepare(
			'SELECT * FROM candidate WHERE candidate_email = ?'
		).bind(email).first();

		if (!existingUser) {
			return new Response(`No user found with email ${email}`, {
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				},
			});
		}

		const id = existingUser.candidate_photo || "default-profile.png";

		const object = await env.photo_storage.get(id as string);

		if (!object) {
			return new Response("File not found", { status: 404 });
		}
	
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
	
		return new Response(object.body, {
			status: 200,
			headers
		});

	}catch(error){
		console.error(`Error fetching user photo for email ${email}`, error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
	}
}

async function updatePicture(email: string, env:Env, request:Request):Promise<Response>{
    console.log(`Updating candidate photo with email ${email}`);
    try {
		// Check if the user exists
		const existingUser = await env.DB.prepare(
			'SELECT * FROM candidate WHERE candidate_email = ?'
		).bind(email).first();

		if (!existingUser) {
			return new Response(`No user found with email ${email}`, {
				status: 400,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				},
			});
		}

		const contentType = request.headers.get("content-type") || "";

		if (contentType.includes("multipart/form-data")) {
			const formData = await request.formData();
			const file = formData.get("file");

			if (!file || typeof file === "string") {
				return new Response("Invalid file", { status: 400 });
			}

			const uuid = crypto.randomUUID(); // Native in Workers
			const key:string = `profile-${uuid}`;

			 // Update user details
			 await env.DB.prepare(`UPDATE candidate SET candidate_photo = ? where candidate_email = ?`)
			.bind(key,email)
			.run();

			await env.photo_storage.put(key, file.stream(), {
				httpMetadata: {
				contentType: file.type,
				}
			});
			return new Response(`Candidate photo updated successfully for ${email}`);
		}

		return new Response("Expected multipart/form-data", { status: 400 });
	}catch (error) {
        console.error(`Error updating user photo for email ${email}`, error);
        return new Response(JSON.stringify({ error: "Internal Server Error" }), {
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
    }
}

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
            `UPDATE candidate SET candidate_name = ?, candidate_gender = ?, candidate_jobtitle = ? WHERE candidate_email = ?`
        )
        .bind(candidate.name, candidate.gender, candidate.jobTitle, candidate.email)
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
					email: existingUser.candidate_email,
					name: existingUser.candidate_name,
					gender: existingUser.candidate_gender,
					jobTitle: existingUser.candidate_jobtitle,
					photo: existingUser.candidate_photo,
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
