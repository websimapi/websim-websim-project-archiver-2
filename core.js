export const API_BASE = '/api/v1';

export async function makeRequest(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const method = options.method || 'GET';
    const start = Date.now();
    
    console.log(`[WebSimAPI] 🔵 ${method} ${url}`);
    
    try {
        const response = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
        
        const ms = Date.now() - start;

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[WebSimAPI] 🔴 FAILED ${url} (${response.status}) - ${ms}ms`);
            console.error(`[WebSimAPI] 🔴 Response Body:`, errorText);

            // Try to parse clean error message
            let cleanMsg = errorText;
            try {
                const json = JSON.parse(errorText);
                if (json.error) {
                    if (typeof json.error === 'string') cleanMsg = json.error;
                    else if (json.error.message) cleanMsg = json.error.message;
                    
                    if (json.error.pathErrors) {
                        cleanMsg += ` | Errors: ${JSON.stringify(json.error.pathErrors)}`;
                    }
                }
            } catch(e) {}
            
            throw new Error(`API ${response.status}: ${cleanMsg}`);
        }
        
        const data = await response.json();
        // Log keys to help debug API shape changes
        const keys = data ? Object.keys(data) : 'null';
        console.log(`[WebSimAPI] 🟢 OK ${url} - ${ms}ms - Keys: [${keys}]`);
        
        return data;
    } catch (err) {
        console.error(`[WebSimAPI] 💥 EXCEPTION ${url}:`, err);
        throw err;
    }
}

export async function fetchRaw(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
}