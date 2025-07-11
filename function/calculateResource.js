const axios = require('axios');
const { logError } = require('../function/logError');

// Configuration object with validation
const hydrapanel = {
    url: process.env.PANEL_URL?.endsWith('/') ? process.env.PANEL_URL.slice(0, -1) : process.env.PANEL_URL,
    key: process.env.PANEL_KEY
};

// Validate configuration
if (!hydrapanel.url || !hydrapanel.key) {
    throw new Error('Panel URL and API key must be configured in environment variables');
}

// Constants for retry mechanism
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;
const BACKOFF_FACTOR = 2;

/**
 * Calculates total resources for a user across all instances
 * @param {string} userID - The user ID to calculate resources for
 * @param {string} resource - The resource type to calculate ('Cpu', 'Memory', etc.)
 * @returns {Promise<number>} Total amount of the specified resource
 * @throws {Error} If the calculation fails after retries or invalid input
 */
async function calculateResource(userID, resource) {
    // Input validation
    if (typeof userID !== 'string' || !userID.trim()) {
        throw new Error('Invalid userID provided');
    }

    if (typeof resource !== 'string' || !resource.trim()) {
        throw new Error('Invalid resource type provided');
    }

    let retries = MAX_RETRIES;
    let delay = INITIAL_DELAY_MS;

    const retryDelay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    while (retries > 0) {
        try {
            //console.log(`Calculating ${resource} for user: ${userID} (attempt ${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);

            const response = await axios.post(
                `${hydrapanel.url}/api/getUserInstance`,
                { userId: userID },
                {
                    headers: {
                        'x-api-key': hydrapanel.key,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 10000 // 10-second timeout
                }
            );

            // Validate response structure
            if (!response?.data || !Array.isArray(response.data)) {
                throw new Error('Invalid response data format: expected an array');
            }

            // Calculate total resources with proper error handling
            const totalResources = response.data.reduce((sum, server) => {
                if (server && typeof server === 'object' && server[resource] !== undefined) {
                    let resourceValue = Number(server[resource]);
                    if (isNaN(resourceValue)) {
                        console.warn(`Invalid ${resource} value for server ${server.id || 'unknown'}`);
                        return sum;
                    }

                    // Special handling for CPU resources
                    if (resource.toLowerCase() === 'cpu') {
                        resourceValue *= 100;
                    }

                    return sum + resourceValue;
                }
                return sum;
            }, 0);

            //console.log(`Successfully calculated ${resource} for user ${userID}: ${totalResources}`);
            return totalResources;

        } catch (err) {
            if (err.response) {
                // Handle API errors
                if (err.response.status === 429) {
                    //console.warn(`Rate limit exceeded. Retrying in ${delay / 1000} seconds...`);
                    await retryDelay(delay);
                    retries--;
                    delay *= BACKOFF_FACTOR;
                    continue;
                }

                // Handle other HTTP errors
                const errorMessage = `API Error: ${err.response.status} - ${err.response.statusText}`;
                logError('calculateResource', errorMessage, {
                    userID,
                    resource,
                    responseData: err.response.data
                });

                if (err.response.status >= 400 && err.response.status < 500) {
                    // Don't retry on client errors
                    throw new Error(`Client error: ${errorMessage}`);
                }
            } else if (err.request) {
                // Handle request errors (no response)
                logError('calculateResource', `No response received: ${err.message}`, {
                    userID,
                    resource
                });
            } else {
                // Handle other errors
                logError('calculateResource', `Unexpected error: ${err.message}`, {
                    userID,
                    resource
                });
            }

            // Only retry on network errors or server errors (5xx)
            if (err.code && ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'].includes(err.code)) {
                console.warn(`Network error (${err.code}). Retrying...`);
                await retryDelay(delay);
                retries--;
                delay *= BACKOFF_FACTOR;
            } else {
                throw err; // Re-throw non-retryable errors
            }
        }
    }

    throw new Error(`Failed to calculate ${resource} for user ${userID} after ${MAX_RETRIES} attempts`);
}

module.exports = { calculateResource };