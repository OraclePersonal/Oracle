#!/usr/bin/env node

/**
 * Multi-Agent Dashboard Feature Development Workflow
 *
 * This script demonstrates how multiple Claude Code instances can coordinate
 * to build a feature together using Oracle MCP.
 *
 * Usage:
 *   node examples/workflow-dashboard.mjs [role]
 *
 * Roles:
 *   lead      - Plans work, creates tasks, reviews
 *   frontend  - Builds React component
 *   backend   - Builds API endpoints
 *   reviewer  - Runs integration tests
 */

import { execFileSync } from 'child_process';

const ROLES = {
  lead: { name: 'claude-code-lead', role: 'Project Lead' },
  frontend: { name: 'claude-code-frontend', role: 'Frontend Developer' },
  backend: { name: 'claude-code-backend', role: 'Backend Developer' },
  reviewer: { name: 'claude-code-reviewer', role: 'QA Engineer' }
};

function ora(...args) {
  return execFileSync('node', ['dist/cli.js', ...args], { encoding: 'utf-8' });
}

async function main() {
  const role = process.argv[2] || 'lead';
  const agent = ROLES[role];

  if (!agent) {
    console.error(`❌ Unknown role: ${role}`);
    console.error(`Available: ${Object.keys(ROLES).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n🤖 Starting Oracle Workflow: ${agent.role}`);
  console.log(`📝 Agent: ${agent.name}\n`);

  // Step 1: Register
  console.log('📍 Registering with Oracle...');
  ora('identity', 'setup', '-n', agent.name);
  console.log(`✅ Registered as ${agent.name}\n`);

  // Step 2: Based on role, run different workflows
  if (role === 'lead') {
    await leadWorkflow(agent);
  } else if (role === 'frontend') {
    await frontendWorkflow(agent);
  } else if (role === 'backend') {
    await backendWorkflow(agent);
  } else if (role === 'reviewer') {
    await reviewerWorkflow(agent);
  }
}

async function leadWorkflow(agent) {
  console.log('👔 LEAD: Creating Dashboard feature tasks...\n');

  // Check who's online
  const agents = ora('msg', 'agents');
  console.log('👥 Online agents:', agents);

  // Create main task
  console.log('\n📝 Creating task for frontend...');
  const frontendTask = ora('task', 'create',
    '--title', 'Build Dashboard React Component',
    '--created-by', agent.name,
    '--assignee', 'claude-code-frontend',
    '--checklist', 'Design component structure',
    'Implement with hooks', 'Write unit tests', 'Update README'
  );
  const frontendId = frontendTask.match(/Created (\S+)/)[1];
  console.log(`✅ Frontend task: ${frontendId}`);

  console.log('\n📝 Creating task for backend...');
  const backendTask = ora('task', 'create',
    '--title', 'Build Dashboard API Endpoints',
    '--created-by', agent.name,
    '--assignee', 'claude-code-backend',
    '--checklist', 'Design API schema',
    'Implement GET /api/dashboard', 'Add database query', 'Write API tests'
  );
  const backendId = backendTask.match(/Created (\S+)/)[1];
  console.log(`✅ Backend task: ${backendId}`);

  console.log('\n📝 Creating task for reviewer...');
  const reviewerTask = ora('task', 'create',
    '--title', 'Integration Test & QA Dashboard',
    '--created-by', agent.name,
    '--assignee', 'claude-code-reviewer',
    '--checklist', 'E2E tests (frontend + backend)',
    'Performance benchmarks', 'Security audit'
  );
  const reviewerId = reviewerTask.match(/Created (\S+)/)[1];
  console.log(`✅ Reviewer task: ${reviewerId}`);

  // Broadcast message
  console.log('\n📢 Broadcasting task assignments...');
  ora('msg', 'send',
    '-f', agent.name,
    '-t', '*',
    '-b', 'Dashboard feature tasks assigned! Please check your inbox.'
  );
  console.log('✅ Message broadcast to all agents\n');

  console.log('⏳ Waiting for agents to submit work...');
  console.log('   (Run workers in separate Claude Code sessions)\n');

  // Wait and display results (this would loop in real usage)
  console.log('📊 Task Status:');
  console.log(`   Frontend: ${frontendId}`);
  console.log(`   Backend:  ${backendId}`);
  console.log(`   Reviewer: ${reviewerId}`);
}

async function frontendWorkflow(agent) {
  console.log('🎨 FRONTEND: Building Dashboard Component...\n');

  // Check inbox
  console.log('📬 Checking messages...');
  const inbox = ora('msg', 'inbox', '-a', agent.name);
  if (inbox.includes('assigned')) {
    console.log('✅ Found task assignment!\n');
  }

  // Find task
  const tasks = ora('task', 'list', '--assignee', agent.name);
  const taskMatch = tasks.match(/(\S+)\s*\|\s*pending.*Dashboard React/);
  if (!taskMatch) {
    console.log('⚠️  No pending tasks found. Waiting for lead to assign work.');
    return;
  }

  const taskId = taskMatch[1];
  console.log(`📌 Working on: ${taskId}\n`);

  // Start work
  console.log('🚀 Starting implementation...');
  ora('task', 'update', taskId,
    '-a', agent.name,
    '--status', 'in_progress',
    '--note', 'Starting component structure design'
  );

  // Simulate work progress
  await sleep(1000);
  console.log('   ✓ Component structure done');
  ora('task', 'check', taskId, '0');

  await sleep(1000);
  console.log('   ✓ Implementation with hooks done');
  ora('task', 'check', taskId, '1');

  await sleep(1000);
  console.log('   ✓ Unit tests written');
  ora('task', 'check', taskId, '2');

  await sleep(1000);
  console.log('   ✓ README updated');
  ora('task', 'check', taskId, '3');

  // Notify backend that we're done
  console.log('\n💬 Sending message to backend...');
  ora('msg', 'send',
    '-f', agent.name,
    '-t', 'claude-code-backend',
    '-b', 'Frontend component ready! Need API integration soon.'
  );

  // Submit for review
  console.log('\n📤 Submitting for review...');
  ora('task', 'submit', taskId,
    '-a', agent.name,
    '--summary', 'Dashboard component complete with tests and docs'
  );
  console.log('✅ Submitted to lead!\n');
}

async function backendWorkflow(agent) {
  console.log('⚙️  BACKEND: Building API Endpoints...\n');

  // Check inbox
  console.log('📬 Checking messages...');
  ora('msg', 'inbox', '-a', agent.name);

  // Find task
  const tasks = ora('task', 'list', '--assignee', agent.name);
  const taskMatch = tasks.match(/(\S+)\s*\|\s*pending.*Dashboard API/);
  if (!taskMatch) {
    console.log('⚠️  No pending tasks found.');
    return;
  }

  const taskId = taskMatch[1];
  console.log(`📌 Working on: ${taskId}\n`);

  // Start work
  console.log('🚀 Starting API implementation...');
  ora('task', 'update', taskId,
    '-a', agent.name,
    '--status', 'in_progress',
    '--note', 'Designing API schema'
  );

  // Simulate work progress
  await sleep(1000);
  console.log('   ✓ API schema designed');
  ora('task', 'check', taskId, '0');

  await sleep(1000);
  console.log('   ✓ GET /api/dashboard implemented');
  ora('task', 'check', taskId, '1');

  await sleep(1000);
  console.log('   ✓ Database query optimized');
  ora('task', 'check', taskId, '2');

  await sleep(1000);
  console.log('   ✓ API tests complete');
  ora('task', 'check', taskId, '3');

  // Notify frontend
  console.log('\n💬 Sending message to frontend...');
  ora('msg', 'send',
    '-f', agent.name,
    '-t', 'claude-code-frontend',
    '-b', 'API ready at /api/dashboard. Response format in docs.'
  );

  // Submit
  console.log('\n📤 Submitting for review...');
  ora('task', 'submit', taskId,
    '-a', agent.name,
    '--summary', 'API endpoints live with database integration and tests'
  );
  console.log('✅ Submitted to lead!\n');
}

async function reviewerWorkflow(agent) {
  console.log('✅ QA: Running Integration Tests...\n');

  // Find task
  const tasks = ora('task', 'list', '--assignee', agent.name);
  const taskMatch = tasks.match(/(\S+)\s*\|\s*pending.*Integration Test/);
  if (!taskMatch) {
    console.log('⚠️  No pending tasks found.');
    return;
  }

  const taskId = taskMatch[1];
  console.log(`📌 Working on: ${taskId}\n`);

  // Wait for frontend & backend
  console.log('⏳ Waiting for frontend + backend to complete...');
  console.log('   (Checking messages for updates)\n');

  await sleep(2000);

  console.log('🚀 Starting integration testing...');
  ora('task', 'update', taskId,
    '-a', agent.name,
    '--status', 'in_progress',
    '--note', 'Setting up E2E test environment'
  );

  await sleep(1000);
  console.log('   ✓ E2E tests pass (frontend + backend)');
  ora('task', 'check', taskId, '0');

  await sleep(1000);
  console.log('   ✓ Performance benchmarks: 95ms load time ✓');
  ora('task', 'check', taskId, '1');

  await sleep(1000);
  console.log('   ✓ Security audit: No vulnerabilities found');
  ora('task', 'check', taskId, '2');

  console.log('\n📤 Submitting QA results...');
  ora('task', 'submit', taskId,
    '-a', agent.name,
    '--summary', 'All integration tests pass. Dashboard ready for production.'
  );
  console.log('✅ Submitted to lead!\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
