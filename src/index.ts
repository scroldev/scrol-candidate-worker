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
	NOTIFY: Fetcher;
}

interface Candidate {
	email: string;
	name?: string;
	gender?: string;
	sector?: string;
	jobTitle?: string;
	cv?: string;
	photo?: string;
	company?: string;
}

interface CV {
	id: string;
	email: string;
	name: string;
	created: string;
	isDefault: boolean;
	originalFilename: string;
}

const headers = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Access-Control-Allow-Origin",
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Handle CORS preflight requests
		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers
			});
		}
		const url = new URL(request.url);

		//BEGIN Unprotected section

		if (url.pathname === "/find" && request.method === "GET") {
			const url = new URL(request.url);
			const query = url.searchParams.get("query");

			if (!query) {
				return new Response(JSON.stringify({ error: "Missing query" }), {
					status: 400,
					headers
				});
			}
			return find(query, env);
		}

		if (url.pathname === "/viewprofile" && request.method === "GET") {
			const candidateId = url.searchParams.get("candidateId");
			if (!candidateId) {
				return new Response(JSON.stringify({ error: "Missing Candidate Id" }), {
					status: 400,
					headers
				});
			}
			return getCandidateInfo(candidateId, "id", env);
		}

		if (url.pathname === "/getpicture" && request.method === "GET") {
			const candidateId = url.searchParams.get("candidateId");
			if (!candidateId) {
				return new Response(JSON.stringify({ error: "Missing Candidate Id" }), {
					status: 400,
					headers
				});
			}
			return getPicture(candidateId, env, "id");
		}

		//END unprotected section

		let body;
		try {
			body = await request.json();
		} catch (e) {
			return new Response('Invalid JSON', {
				status: 400,
				headers
			});
		}

		const { token } = body as { token?: string };

		if (!token) {
			return new Response('Token is required', {
				status: 400,
				headers
			});
		}

		const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
		if (!response.ok) {
			const errorText = await response.text();
			console.error(`Token verification failed for token ${token}`, response.status, errorText);
			return new Response(JSON.stringify({ error: "invalid_token" }), {
				status: 400,
				headers
			});
		}

		const payload = await response.json();

		const email = payload['email'] as string;

		if (url.pathname === "/" && request.method === "POST") {
			return getCandidateInfo(email, "email", env);
		}

		if (url.pathname === "/block" && request.method === "POST") {
			const friendId = url.searchParams.get("friendId");
			if (!friendId) {
				return new Response(JSON.stringify({ error: "Missing friendId" }), {
					status: 400,
					headers
				});
			}
			return blockFriend(friendId, email, env);
		}


		if (url.pathname === "/addfriend" && request.method === "POST") {
			const friendId = url.searchParams.get("friendId");
			if (!friendId) {
				return new Response(JSON.stringify({ error: "Missing friendId" }), {
					status: 400,
					headers
				});
			}
			return addFriend(friendId, email, env);
		}

		if (url.pathname === "/myfriends" && request.method == "POST") {
			const limit = url.searchParams.get("limit");
			const page = url.searchParams.get("page");
			if (limit && page) {
				return listFriends(email, limit, page, env);
			} else {
				return new Response(JSON.stringify({ error: "Missing limit or page params" }), {
					status: 400,
					headers
				});
			}
		}


		if (url.pathname === "/getpicture" && request.method === "POST") {
			return getPicture(email, env, "email");
		}

		if (url.pathname === "/listcvs" && request.method === "POST") {
			return listCVs(email, env);
		}

		if (url.pathname === "/update" && request.method === "POST") {
			const { candidate } = body as { candidate?: Partial<Candidate> };

			if (!candidate) {
				return new Response('Candidate is required', { status: 400, headers });
			}
			return updateCandidate(candidate, env);
		}

		return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
	},
} satisfies ExportedHandler<Env>;

async function sendNotification(email: string, text: string, env: Env) {
	console.log(`Sending email to ${email}`);
	const req = new Request("https://dummy/sendto", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message: text, email: email })
	});

	const response = await env.NOTIFY.fetch(req);

	console.log("response", response);
	if (!response.ok) {
		console.error("Unable to send email", response);
		throw new Error("Unable to send email");
	}
}

async function listFriends(email: string, limit: string, page: string, env: Env) {
	try {
		const offset = (parseInt(page) - 1) * parseInt(limit);
		const response = await env.DB.prepare(
			'SELECT f.friend_id as friendId, f.created, r.candidate_name as name \
			 FROM friends f, candidate c, candidate r \
			 WHERE c.candidate_id = f.candidate_id \
			 AND f.friend_id = r.candidate_id \
			 AND c.candidate_email = ? \
			 AND "ACTIVE" = f.status \
			 UNION \
			 SELECT f.candidate_id as friendId, f.created, r.candidate_name as name \
			 FROM friends f, candidate c, candidate r \
			 WHERE c.candidate_id = f.friend_id \
			 AND f.candidate_id = r.candidate_id \
			 AND c.candidate_email = ? \
			 AND "ACTIVE" = f.status \
			 limit ? offset ? \
			 '
		).bind(email, email, limit, offset).all();

		return new Response(JSON.stringify(response.results), { headers });

	} catch (error) {
		console.error("Unable to list friends", error);
		return new Response(JSON.stringify({ error: "Unable to add friend" }), { status: 400, headers });
	}
}


async function blockFriend(friendId: string, email: string, env: Env) {
	try {
		console.log(`Blocking friend with id ${friendId} for email ${email}`);

		const existingUser = await env.DB.prepare(
			'SELECT * FROM candidate WHERE candidate_email = ?'
		).bind(email).first();

		if (!existingUser) {
			throw new Error(`User with email ${email} does not exist`);
		}

		console.log(`[${friendId}] AND [${existingUser.candidate_id}] will be blocked`);

		const blockQuery: string = 'UPDATE friends SET status = ? \
									WHERE friend_id = ? AND candidate_id = ?';

		await env.DB.prepare(blockQuery).bind('BLOCKED', friendId, existingUser.candidate_id).run();
		await env.DB.prepare(blockQuery).bind('BLOCKED', existingUser.candidate_id, friendId).run();

		return new Response(JSON.stringify({ message: `${friendId} has been blocked` }), { headers });

	} catch (error) {
		console.error("Unable to block friend", error);
		return new Response(JSON.stringify({ error: "Unable to block friend" }), { status: 400, headers });
	}
}

async function addFriend(friendId: string, email: string, env: Env) {
	try {
		console.log(`Adding friend ${friendId} for email ${email}`);
		// Check if the user exists
		const existingUser = await env.DB.prepare(
			'SELECT * FROM candidate WHERE candidate_email = ?'
		).bind(email).first();

		const friend = await env.DB.prepare(
			'SELECT * FROM candidate WHERE candidate_id = ?'
		).bind(friendId).first();

		if (existingUser && friend) {
			await env.DB.prepare(
				'INSERT INTO friends(candidate_id, friend_id, created, status) values (?,?,?,?)'
			).bind(existingUser.candidate_id, friendId, new Date().toISOString(), "ACTIVE").run();

			await sendNotification(`${friend.candidate_email}`,
				`${existingUser.candidate_name} has sent you a friend request! visit <a href="https://scrol.asia/friends">Your Friends List</a> to view.`, env);

			return new Response(JSON.stringify({ message: "Friend added successfully" }), { headers });
		} else {
			return new Response(JSON.stringify({ error: "Users do not exist" }), { status: 400, headers });
		}
	} catch (error) {
		console.error("Unable to add friend", error);
		return new Response(JSON.stringify({ error: "Unable to add friend" }), { status: 400, headers });
	}
}

async function find(query: string, env: Env) {

	try {
		const results = await env.DB.prepare(
			'SELECT c.candidate_id as id, c.candidate_name as name, c.candidate_email as email FROM candidate c WHERE c.candidate_email like ? OR c.candidate_name like ?'
		).bind(`%${query}%`, `%${query}%`).all();

		return new Response(JSON.stringify(results.results), { headers });
	} catch (error) {
		console.error(`Unable to run find query ${query}`, error);
		return new Response(JSON.stringify({ error: "Unable to run find query" }), {
			status: 400,
			headers
		});
	}
}

async function listCVs(email: string, env: Env): Promise<Response> {
	console.log(`Fetching candidate cvs using email ${email}`);
	try {
		// Check if the user exists
		const existingUser = await env.DB.prepare(
			'SELECT * FROM candidate WHERE candidate_email = ?'
		).bind(email).first();

		if (!existingUser) {
			return new Response(`No user found with email ${email}`, {
				status: 400,
				headers
			});
		}

		// Fetch all the cvs the candidate has uploaded.
		const cvList = await env.DB.prepare(
			'SELECT * FROM cv WHERE candidate_email = ?'
		).bind(email).all();

		console.log(`found ${cvList.results.length} results for email ${email}`);

		// Marshal database results to the CV interface
		const cvs = cvList.results.map(cv => ({
			id: cv.cv_id,
			email: cv.candidate_email,
			name: cv.cv_name,
			created: cv.cv_created,
			isDefault: cv.cv_default === "true",
			originalFilename: cv.original_filename
		}));

		// Return the list as JSON
		return new Response(JSON.stringify(cvs), {
			status: 200,
			headers
		});
	} catch (error) {
		console.error(`Error fetching cv data for email ${email}`, error);
		return new Response(JSON.stringify({ error: "Internal Server Error" }), {
			status: 500,
			headers
		});
	}
}

async function getPicture(queryId: string, env: Env, idType: string): Promise<Response> {

	console.log(`Fetching candidate photo with id ${queryId}`);
	try {
		// Check if the user exists
		let sqlQuery: string;
		if ("id" === idType) {
			sqlQuery = 'SELECT * FROM candidate WHERE candidate_id = ?';
		} else {
			sqlQuery = 'SELECT * FROM candidate WHERE candidate_email = ?';
		}

		const existingUser = await env.DB.prepare(`${sqlQuery}`).bind(queryId).first();

		if (!existingUser) {
			return new Response(JSON.stringify({ error: `No user found with email ${queryId}` }), {
				status: 400,
				headers
			});
		}

		const id = existingUser.candidate_photo || "Default_pfp.jpg";

		const object = await env.photo_storage.get(id as string);

		if (!object) {
			return new Response("File not found", {
				status: 404,
				headers
			});
		}

		const newHeaders = new Headers();
		object.writeHttpMetadata(newHeaders);
		newHeaders.set("Content-Type", object.httpMetadata?.contentType || "image/jpeg");
		newHeaders.set("Access-Control-Allow-Origin", "*");
		newHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

		return new Response(object.body, { headers: newHeaders });

	} catch (error) {
		console.error(`Error fetching user photo for id ${queryId}}`, error);
		return new Response(JSON.stringify({ error: "Internal Server Error" }), {
			status: 500,
			headers
		});
	}
}

async function updateCandidate(candidate: Partial<Candidate>, env: Env) {
	console.log(`Updating candidate data with email ${candidate.email}`);
	try {
		// Check if the user exists
		const existingUser = await env.DB.prepare(
			'SELECT * FROM candidate WHERE candidate_email = ?'
		).bind(candidate.email).first();

		if (!existingUser) {
			return new Response(`No user found with email ${candidate.email}`, {
				status: 400,
				headers
			});
		}

		// Update user details
		await env.DB.prepare(
			`UPDATE candidate SET candidate_name = ?, candidate_gender = ?, candidate_sector = ?, candidate_jobtitle = ?, candidate_company = ? WHERE candidate_email = ?`
		)
			.bind(candidate.name, candidate.gender, candidate.sector, candidate.jobTitle, candidate.company, candidate.email)
			.run();

		// Retrieve updated candidate
		const updatedCandidate = await env.DB.prepare(
			'SELECT * FROM candidate WHERE candidate_email = ?'
		).bind(candidate.email).first();

		return new Response(
			JSON.stringify({ message: "Candidate updated successfully", candidate: updatedCandidate }), { headers });
	} catch (error) {
		console.error(`Error updating user with email ${candidate.email}`, error);
		return new Response(JSON.stringify({ error: "Internal Server Error" }), {
			status: 500,
			headers,
		});
	}
}


async function getCandidateInfo(id: string, idType: string, env: Env): Promise<Response> {
	console.log(`Retrieving candidate data with id ${id}`);
	try {

		const sql = "email" === idType ? `SELECT * FROM candidate WHERE candidate_email = ?` : `SELECT * FROM candidate WHERE candidate_id = ?`;
		// Check if user exists in the database
		const existingUser = await env.DB.prepare(
			sql
		).bind(id).first();

		if (!existingUser) {
			return new Response(`No user found with id ${id}`,
				{
					status: 400,
					headers
				});
		} else {
			return new Response(
				JSON.stringify({
					id: existingUser.candidate_id,
					email: existingUser.candidate_email,
					name: existingUser.candidate_name,
					gender: existingUser.candidate_gender,
					sector: existingUser.candidate_sector,
					jobTitle: existingUser.candidate_jobtitle,
					photo: existingUser.candidate_photo,
					company: existingUser.candidate_company,
					cv: existingUser.cv
				}), { headers }
			);
		}
	} catch (error) {
		console.log(`Error fetching user with id ${id}`, error);
		return new Response(JSON.stringify({ error: error }), {
			status: 500,
			headers,
		});
	}
}
