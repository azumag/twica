#!/usr/bin/env node

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ngrok = require('ngrok');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require('child_process');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env.local');

async function startDev() {
  console.log('🚀 Starting development environment...\n');

  try {
    // Start ngrok
    console.log('📡 Starting ngrok tunnel...');
    const url = await ngrok.connect(3000);

    console.log(`✅ ngrok tunnel started: ${url}\n`);

    // Update .env.local
    console.log('📝 Updating .env.local...');
    let envContent = fs.readFileSync(ENV_FILE, 'utf8');

    // Update or add NEXT_PUBLIC_APP_URL
    const appUrlRegex = /^NEXT_PUBLIC_APP_URL=.*$/m;
    if (appUrlRegex.test(envContent)) {
      envContent = envContent.replace(appUrlRegex, `NEXT_PUBLIC_APP_URL=${url}`);
    } else {
      envContent += `\nNEXT_PUBLIC_APP_URL=${url}\n`;
    }

    fs.writeFileSync(ENV_FILE, envContent);
    console.log(`✅ Updated NEXT_PUBLIC_APP_URL to ${url}\n`);

    // Display important information
    console.log('⚠️  IMPORTANT: Add this URL to Twitch Developer Console:');
    console.log(`   ${url}/api/auth/twitch/callback\n`);
    console.log('   Visit: https://dev.twitch.tv/console/apps\n');

    // Start Next.js dev server
    console.log('🚀 Starting Next.js development server...\n');
    const nextProcess = spawn('npm', ['run', 'dev:next'], {
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        NEXT_PUBLIC_APP_URL: url,
      }
    });

    // Handle cleanup
    const cleanup = async () => {
      console.log('\n\n🛑 Shutting down...');
      nextProcess.kill();
      await ngrok.kill();
      console.log('✅ Cleanup complete');
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    nextProcess.on('exit', async (code) => {
      await ngrok.kill();
      process.exit(code);
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

startDev();
