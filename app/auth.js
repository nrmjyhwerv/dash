const express = require("express");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const axios = require("axios");
const randomstring = require("randomstring");
const router = express.Router();

const { db } = require("../function/db");
const { logError } = require("../function/logError");

const hydrapanel = {
    url: process.env.PANEL_URL?.endsWith("/")
        ? process.env.PANEL_URL.slice(0, -1)
        : process.env.PANEL_URL,
    key: process.env.PANEL_KEY,
};

// Validate required environment variables
const requiredEnvVars = [
    "PANEL_URL",
    "PANEL_KEY",
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "DISCORD_CALLBACK_URL",
];

for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        throw new Error(`Missing required environment variable: ${envVar}`);
    }
}

// Configure passport to use Discord
passport.use(
    new DiscordStrategy(
        {
            clientID: process.env.DISCORD_CLIENT_ID,
            clientSecret: process.env.DISCORD_CLIENT_SECRET,
            callbackURL: process.env.DISCORD_CALLBACK_URL,
            scope: ["identify", "email"],
            passReqToCallback: false,
        },
        (accessToken, refreshToken, profile, done) => {
            if (!profile?.id || !profile?.username || !profile?.email) {
                return done(new Error("Incomplete profile data from Discord"));
            }
            return done(null, profile);
        },
    ),
);

// Serialize and deserialize user
passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((user, done) => {
    done(null, user);
});

/**
 * Checks if an account exists in HydraPanel and creates one if it doesn't
 * @param {string} email - User's email
 * @param {string} username - User's username
 * @param {string} id - User's Discord ID
 * @returns {Promise<void>}
 */
async function checkAccount(email, username, id) {
    if (!email || !username || !id) {
        throw new Error("Missing required parameters for account check");
    }

    try {
        // Check if user already exists in hydrapanel
        let response;
        try {
            response = await axios.post(
                `${hydrapanel.url}/api/getUser`,
                {
                    type: "email",
                    value: email,
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": hydrapanel.key,
                    },
                    timeout: 10000, // 10 seconds timeout
                },
            );

            // User exists, store their ID and return
            if (response.data?.userId) {
                //console.log(`User ${email} exists in Cryptalispanel. User ID: ${response.data.userId}`,);
                await db.set(`id-${email}`, response.data.userId);
                return;
            }
        } catch (err) {
            if (err.response) {
                if (
                    err.response.status === 404 ||
                    err.response.status === 400
                ) {
                    // User does not exist, proceed to create
                    //console.log(`User ${email} does not exist in Cryptalispanel, creating new account...`,);
                } else {
                    // Handle other HTTP errors
                    throw new Error(
                        `CryptalisPanel API error: ${err.response.status} - ${err.response.data?.message || "Unknown error"}`,
                    );
                }
            } else if (err.request) {
                // The request was made but no response was received
                throw new Error("No response from CryptalisPanel API");
            } else {
                // Something happened in setting up the request
                throw new Error(
                    `Error setting up request to CryptalisPanel: ${err.message}`,
                );
            }
        }

        // Generate a random password for new user
        const password = randomstring.generate({
            length: parseInt(process.env.PASSWORD_LENGTH) || 16,
            charset: "alphanumeric",
        });

        // Create user in hydrapanel
        try {
            const createResponse = await axios.post(
                `${hydrapanel.url}/api/auth/create-user`,
                {
                    username: username,
                    email: email,
                    password: password,
                    userId: id,
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": hydrapanel.key,
                    },
                    timeout: 10000,
                },
            );

            if (!createResponse.data?.userId) {
                throw new Error(
                    "Failed to get user ID from CryptalisPanel response",
                );
            }

            // Store credentials securely
            await Promise.all([
                db.set(`password-${email}`, password),
                db.set(`id-${email}`, createResponse.data.userId),
            ]);

            //console.log(`User ${email} created successfully in CryptalisPanel`);
        } catch (err) {
            if (err.response?.status === 409) {
                //console.log("User creation conflict: User already exists in Cryptalispanel.",);
            } else {
                throw new Error(
                    `Failed to create user in CryptalisPanel: ${err.message}`,
                );
            }
        }
    } catch (error) {
        //logError("Error during account check", error);
        throw error; // Re-throw to be handled by the caller
    }
}

// Discord login route
router.get("/login/discord", (req, res, next) => {
    // Store returnTo URL from query parameter if provided
    if (req.query.returnTo) {
        req.session.returnTo = req.query.returnTo;
    }
    passport.authenticate("discord")(req, res, next);
});

// Discord callback route
router.get("/callback/discord", (req, res, next) => {
    passport.authenticate("discord", {
        failureRedirect: "/login",
        failWithError: true,
    })(req, res, (err) => {
        if (err) {
            //logError("Discord authentication failed", err);
            return res.redirect("/login?error=auth_failed");
        }

        if (!req.user) {
            //logError("No user object after authentication");
            return res.redirect("/login?error=no_user");
        }

        checkAccount(req.user.email, req.user.username, req.user.id)
            .then(() => {
                const redirectUrl = req.session.returnTo || "/dashboard";
                delete req.session.returnTo; // Clean up
                res.redirect(redirectUrl);
            })
            .catch((error) => {
                //logError("Error during account check", error);
                res.redirect("/dashboard?error=account_check_failed");
            });
    });
});

router.get("/auth/login", async (req, res, next) => {
    passport.authenticate("local", (err, user, info) => {
        if (err) {
            return next(err);
        }
        if (!user) {
            if (info.userNotVerified) {
                return res.redirect("/login?err=UserNotVerified");
            }
            return res.redirect("/login?err=InvalidCredentials&state=failed");
        }
        req.logIn(user, async (err) => {
            if (err) {
                return next(err);
            }

            const users = await db.get("users");
            const dbUser = users.find((u) => u.username === user.username);

            if (dbUser && dbUser.twoFAEnabled) {
                req.session.tempUser = user;
                req.user = null;
                return res.redirect("/2fa");
            } else {
                return res.redirect("/dashboard");
            }
        });
    })(req, res, next);
});

router.post(
    "/auth/login",
    passport.authenticate("local", {
        failureRedirect: "/login?err=InvalidCredentials&state=failed",
    }),
    async (req, res, next) => {
        try {
            if (req.user) {
                const users = await db.get("users");
                const user = users.find(
                    (u) => u.username === req.user.username,
                );

                if (user && user.verified) {
                    return res.redirect("/dashboard");
                }

                if (user && user.twoFAEnabled) {
                    req.session.tempUser = req.user;
                    req.logout((err) => {
                        if (err) {
                            return next(err);
                        }
                        return res.redirect("/2fa");
                    });
                } else {
                    return res.redirect("/dashboard");
                }
            } else {
                return res.redirect(
                    "/login?err=InvalidCredentials&state=failed",
                );
            }
        } catch (error) {
            //console.error("Error during login:", error);
            return res.status(500).send("Internal Server Error");
        }
    },
);

// Logout route
router.get("/logout", (req, res) => {
    const returnTo = req.query.returnTo || "/";
    req.logout((err) => {
        if (err) {
            logError("Logout failed", err);
        }
        req.session.destroy(() => {
            res.redirect(returnTo);
        });
    });
});

module.exports = router;
