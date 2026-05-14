require('dotenv').config();

async function run() {
    console.log("🔍 Checking Frame.io API Vision...");
    
    try {
        const teamsRes = await fetch('https://api.frame.io/v2/teams', {
            headers: { 'Authorization': `Bearer ${process.env.FRAMEIO_TOKEN}` }
        });
        const teams = await teamsRes.json();
        
        if (!teams || teams.length === 0) {
            console.log("❌ API sees NO Teams/Workspaces.");
            return;
        }

        for (const team of teams) {
            console.log(`\n📁 FOUND TEAM/WORKSPACE: "${team.name}" (ID: ${team.id})`);
            
            const projRes = await fetch(`https://api.frame.io/v2/teams/${team.id}/projects`, {
                headers: { 'Authorization': `Bearer ${process.env.FRAMEIO_TOKEN}` }
            });
            const projects = await projRes.json();
            
            if (projects && projects.length > 0) {
                projects.forEach(p => console.log(`   ↳ 🎬 Project: "${p.name}" (ID: ${p.id}, Root Asset: ${p.root_asset_id})`));
            } else {
                console.log(`   ↳ ⚠️ No projects found in this workspace.`);
            }
        }
    } catch (e) {
        console.error("Network error:", e);
    }
}

run();