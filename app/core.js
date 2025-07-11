const express = require("express");
const axios = require("axios");
const fs = require("fs");

const { db } = require("../function/db.js");
const { ensureAuthenticated } = require("../function/ensureAuthenticated.js");
const { checkPassword } = require("../function/checkPassword.js");
const { calculateResource } = require("../function/calculateResource.js");

const router = express.Router();

const hydrapanel = {
    url: process.env.PANEL_URL,
    key: process.env.PANEL_KEY,
};

// Load plans
let plans = {};
try {
    const data = fs.readFileSync("./storage/plans.json", "utf8");
    plans = JSON.parse(data).PLAN;
} catch (err) {
    console.error("Failed to load plans:", err);
    process.exit(1);
}

// Resources

async function getUserPlan(email) {
    let plan = await db.get(`plan-${email}`);
    if (!plan) {
        plan = `${process.env.DEFAULT_PLAN}`; // Default plan
        await db.set(`plan-${email}`, plan);
    }
    return plan.toUpperCase();
}

// Existing resources (the ones in use on servers)
const existingResources = async (userID) => {
    return {
        cpu: await calculateResource(userID, "Cpu"),
        ram: await calculateResource(userID, "Memory"),
        disk: await calculateResource(userID, "Disk"), // D
    };
};

// Max resources (the ones the user has purchased or been given)
const maxResources = async (email) => {
    return {
        cpu: await db.get(`cpu-${email}`),
        ram: await db.get(`ram-${email}`),
        disk: await db.get(`disk-${email}`),
        server: await db.get(`server-${email}`),
    };
};

// Set default resources

async function ensureResourcesExist(email) {
    const planKey = await getUserPlan(email);
    const plan = plans[planKey].resources;
    const resources = await maxResources(email);

    if (!resources.cpu || resources.cpu == 0) {
        await db.set(`cpu-${email}`, plan.cpu);
    }

    if (!resources.ram || resources.ram == 0) {
        await db.set(`ram-${email}`, plan.ram);
    }

    if (!resources.disk || resources.disk == 0) {
        await db.set(`disk-${email}`, plan.disk);
    }

    if (!resources.server || resources.server == 0) {
        await db.set(`server-${email}`, plan.server);
    }

    // Might as well add the coins too instead of having 2 separate functions
    if (!(await db.get(`coins-${email}` || 0))) {
        await db.set(`coins-${email}`, 0.0);
    }
}

// Pages / Routes
router.get("/", (req, res) => {
    res.render("index", {
        req: req, // Requests (queries)
        name: process.env.APP_NAME, // Dashboard name
        user: req.user, // User info (if logged in)
    });
});

router.get("/privacypolicy", (req, res) => {
    res.render("privacypolicy", {
        req: req, // Requests (queries)
        name: process.env.APP_NAME, // Dashboard name
        user: req.user, // User info (if logged in)
    });
});

router.get("/invite", (req, res) => {
    res.render("invite", {
        req: req, // Requests (queries)
        name: process.env.APP_NAME, // Dashboard name
        user: req.user, // User info (if logged in)
    });
});

router.get("/linkvertise", ensureAuthenticated, async (req, res) => {
    if (!req.user || !req.user.email || !req.user.id)
        return res.redirect("/login/discord");
    res.render("linkvertise", {
        coins: await db.get(`coins-${req.user.email}`), // User's coins
        req: req, // Request (queries)
        name: process.env.APP_NAME, // Dashboard name
        user: req.user, // User info
        admin: await db.get(`admin-${req.user.email}`), // Admin status
        password: await checkPassword(req.user.email), // Account password
    });
});

// Dashboard
router.get("/dashboard", ensureAuthenticated, async (req, res) => {
    try {
        if (!req.user || !req.user.email || !req.user.id)
            return res.redirect("/login/discord");
        //console.log("init dash");
        try {
            const response = await axios.post(
                `${hydrapanel.url}/api/getUserInstance`,
                {
                    userId: req.user.id,
                },
                {
                    headers: {
                        "x-api-key": hydrapanel.key,
                    },
                },
            );

            const servers = response.data || [];
            //console.log("finsh servers calc");

            // Ensure all resources are set to 0 if they don't exist
            await ensureResourcesExist(req.user.email);
            //console.log("finsh ensureResourcesExist calc");

            // Calculate existing and maximum resources
            const existing = await existingResources(req.user.id);
            const max = await maxResources(req.user.email);

            res.render("dashboard", {
                coins: await db.get(`coins-${req.user.email}`), // User's coins
                req: req, // Request (queries)
                name: process.env.APP_NAME || "CRYPTALIS", // Dashboard name
                user: req.user, // User info
                servers, // Servers the user owns
                existing, // Existing resources
                max, // Max resources,
                admin: (await db.get(`admin-${req.user.email}`)) || false, // Admin status
            });
        } catch (err) {
            res.redirect("/?err=INTERNALERROR");
        }
    } catch (err) {
        res.redirect("/?err=INTERNALERROR");
    }
});

// Credentials
router.get("/credentials", ensureAuthenticated, async (req, res) => {
    if (!req.user || !req.user.email || !req.user.id)
        return res.redirect("/login/discord");
    res.render("credentials", {
        coins: await db.get(`coins-${req.user.email}`), // User's coins
        req: req, // Request (queries)
        name: process.env.APP_NAME, // Dashboard name
        user: req.user, // User info
        admin: await db.get(`admin-${req.user.email}`), // Admin status
        password: await checkPassword(req.user.email), // Account password
        name: (await db.get("name")) || "CRYPTALIS",
        logo: (await db.get("logo")) || false,
    });
});

router.get("/news", ensureAuthenticated, async (req, res) => {
    if (!req.user || !req.user.email || !req.user.id)
        return res.redirect("/login/discord");
    res.render("announcment", {
        coins: await db.get(`coins-${req.user.email}`), // User's coins
        req: req, // Request (queries)
        name: process.env.APP_NAME, // Dashboard name
        discordserver: process.env.DISCORD_SERVER,
        theme: require("../storage/theme.json"), // Theme data
        announcements: require("../storage/announcement.json"),
        user: req.user, // User info
        admin: await db.get(`admin-${req.user.email}`), // Admin status
        password: await checkPassword(req.user.email), // Account password
    });
});

router.get("/invite", ensureAuthenticated, async (req, res) => {
    res.render("invite", {
        name: process.env.APP_NAME, // Dashboard name
    });
});

router.get("/privacypolicy", ensureAuthenticated, async (req, res) => {
    res.render("privacypolicy", {
        name: process.env.APP_NAME, // Dashboard name
    });
});

router.get("/terms", ensureAuthenticated, async (req, res) => {
    res.render("terms", {
        name: process.env.APP_NAME, // Dashboard name
    });
});

router.get("/profile", ensureAuthenticated, async (req, res) => {
    try {
        // Validate user session
        if (!req.user?.email || !req.user?.id) {
            //console.error("Profile access attempt without valid user session");
            return res.redirect("/login/discord");
        }

        // Log the profile access for debugging
        //console.log(`Profile access by ${req.user.email} (${req.user.id})`);

        // Get user data
        let servers = [];
        try {
            const response = await axios.post(
                `${hydrapanel.url}/api/getUserInstance`,
                {
                    userId: req.user.id,
                    discordserver: process.env.DISCORD_SERVER,
                },
                {
                    headers: {
                        "x-api-key": hydrapanel.key,
                    },
                    timeout: 5000, // Add timeout to prevent hanging
                },
            );

            servers = response.data || [];
        } catch (apiError) {
            console.error("Error fetching user instances:", apiError.message);
            // Continue with empty servers array rather than failing completely
        }

        // Ensure resources exist
        try {
            await ensureResourcesExist(req.user.email);
        } catch (resourceError) {
            console.error("Error ensuring resources:", resourceError.message);
            // Continue rendering profile even if resource initialization fails
        }

        // Get user resources
        let existing, max;
        try {
            existing = await existingResources(req.user.id);
            max = await maxResources(req.user.email);
        } catch (resourceError) {
            console.error("Error fetching resources:", resourceError.message);
            // Set default values if resource fetch fails
            existing = { cpu: 0, ram: 0, disk: 0, servers: 0 };
            max = { cpu: 0, ram: 0, disk: 0, servers: 0 };
        }

        // Get coins and admin status
        let coins, admin;
        try {
            coins = (await db.get(`coins-${req.user.email}`)) || 0;
            admin = (await db.get(`admin-${req.user.email}`)) || false;
        } catch (dbError) {
            console.error("Database error:", dbError.message);
            coins = 0;
            admin = false;
        }

        // Render profile page
        res.render("profile", {
            coins: coins,
            req: req,
            name: process.env.APP_NAME || "CRYPTALIS",
            discordserver: process.env.DISCORD_SERVER,
            user: req.user,
            servers: servers,
            existing: existing,
            max: max,
            admin: admin,
        });
    } catch (err) {
        console.error("Unexpected error in profile route:", err);
        res.redirect(`/?err=INTERNALERROR&t=${Date.now()}`);
    }
});

// Panel
router.get("/panel", (req, res) => {
    res.redirect(`${hydrapanel.url}/login`);
});
// Panel DISCORD INVITE
router.get("/help", (req, res) => {
    res.redirect(process.env.DISCORD_SERVER);
});

// Assets
router.use("/public", express.static("public"));

module.exports = router;
