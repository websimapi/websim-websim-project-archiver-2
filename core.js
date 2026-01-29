export const API_BASE = '/api/v1';

export async function makeRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    console.log(`[WebSimAPI] Requesting: ${url}`);
    
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options.headers
        }
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[WebSimAPI] Request Failed: ${url} (${response.status})`);
        // Try to parse clean error message
        let cleanMsg = errorText;
        try {
            const json = JSON.parse(errorText);
            if (json.error && json.error.message) cleanMsg = json.error.message;
            if (json.error && json.error.pathErrors) cleanMsg += ` (${JSON.stringify(json.error.pathErrors)})`;
        } catch(e) {}
        console.error(`[WebSimAPI] Details:`, cleanMsg);
        throw new Error(`API Error ${response.status}: ${cleanMsg}`);
    }
    
    return response.json();
}

export async function fetchRaw(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
}