import { makeRequest } from './core.js';

export function getProjectById(projectId) {
    return makeRequest(`/projects/${projectId}`);
}

export function getProjectBySlug(username, slug) {
    return makeRequest(`/users/${username}/slugs/${slug}`);
}

export function getProjectRevisions(projectId, params = {}) {
    const query = new URLSearchParams(params).toString();
    return makeRequest(`/projects/${projectId}/revisions?${query}`);
}

export async function getAllProjectRevisions(projectId) {
    console.log(`[API-Project] 📚 Fetching history for ${projectId}...`);
    let allRevisions = [];
    let hasNextPage = true;
    let afterCursor = null;
    let pageCount = 0;
    const MAX_PAGES = 500; 

    while (hasNextPage && pageCount < MAX_PAGES) {
        console.log(`[API-Project] 📖 Page ${pageCount + 1} (cursor: ${afterCursor || 'START'})...`);
        const params = { first: 50 };
        if (afterCursor) params.after = afterCursor;

        try {
            const response = await getProjectRevisions(projectId, params);
            
            // Normalize Response
            let pageData = [];
            let meta = null;

            // 1. { revisions: { data: [], meta: {} } }
            if (response.revisions?.data) {
                pageData = response.revisions.data;
                meta = response.revisions.meta;
            } 
            // 2. { data: [], meta: {} } (Standard pagination)
            else if (response.data) {
                pageData = response.data;
                meta = response.meta;
            }
            // 3. { revisions: [] }
            else if (Array.isArray(response.revisions)) {
                pageData = response.revisions;
            }
            // 4. [] (Direct array)
            else if (Array.isArray(response)) {
                pageData = response;
            }

            console.log(`[API-Project] 🧩 Parsed ${pageData.length} items from Page ${pageCount + 1}`);

            if (pageData.length > 0) {
                // Unwrap if wrapped in { revision: ... }
                // Sometimes the API returns { id:..., revision: { ... } }
                if (pageData[0].revision && typeof pageData[0].revision === 'object') {
                     console.log('[API-Project] Unwrapping nested revision objects...');
                     pageData = pageData.map(r => r.revision);
                }
                allRevisions.push(...pageData);
            } else {
                console.log('[API-Project] Empty page received. Stopping.');
                hasNextPage = false;
            }
            
            // Cursor Logic
            if (meta?.has_next_page && meta?.end_cursor) {
                afterCursor = meta.end_cursor;
            } else {
                // Check if we just ran out of array data without meta
                if (!meta) console.log(`[API-Project] No pagination metadata found. Assuming end.`);
                else console.log(`[API-Project] End of list reached (has_next=${meta.has_next_page}).`);
                hasNextPage = false;
            }

        } catch (e) {
            console.error(`[API-Project] ⚠️ Failed page ${pageCount}:`, e);
            hasNextPage = false;
        }
        pageCount++;
    }

    // Filter valid revisions and deduplicate
    const unique = new Map();
    allRevisions.forEach(r => {
        if (r && (r.version !== undefined || r.id)) {
            // Use version as key if available, else ID
            const key = r.version !== undefined ? r.version : r.id;
            unique.set(key, r);
        }
    });

    const finalRevisions = Array.from(unique.values()).sort((a,b) => {
        const vA = a.version || 0;
        const vB = b.version || 0;
        return vA - vB;
    });

    console.log(`[API-Project] ✅ History Complete: ${finalRevisions.length} unique revisions.`);
    return finalRevisions;
}

export function parseProjectIdentifier(input) {
    if (!input) return null;
    
    try {
        const url = new URL(input.startsWith('http') ? input : `https://${input}`);
        const pathname = url.pathname;

        const projectMatch = pathname.match(/^\/p\/([a-z0-9_-]{20})/);
        if (projectMatch) return { type: 'id', value: projectMatch[1] };

        const slugMatch = pathname.match(/^\/(@[^/]+)\/([^/]+)/);
        if (slugMatch) return { type: 'slug', username: slugMatch[1].substring(1), slug: slugMatch[2] };
        
        const cMatch = pathname.match(/^\/c\/([a-z0-9_-]{20})/);
        if (cMatch) return { type: 'id', value: cMatch[1] };

    } catch (e) { /* Not a URL */ }

    const atSlugMatch = input.match(/^@([^/]+)\/([^/]+)/);
    if (atSlugMatch) return { type: 'slug', username: atSlugMatch[1], slug: atSlugMatch[2] };

    const slugMatch = input.match(/^([a-zA-Z0-9_]{3,32})\/([a-zA-Z0-9-]{3,50})$/);
    if (slugMatch) return { type: 'slug', username: slugMatch[1], slug: slugMatch[2] };

    if (/^[a-z0-9_-]{20}$/.test(input)) return { type: 'id', value: input };

    throw new Error(`Invalid project identifier: "${input}".`);
}

export async function fetchProjectMetadata(identifier) {
    if (identifier.type === 'id') {
        return getProjectById(identifier.value);
    } else {
        return getProjectBySlug(identifier.username, identifier.slug);
    }
}