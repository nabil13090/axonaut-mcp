module.exports = {
  apps: [
    {
      name: "axonaut-mcp",
      script: "dist/index.js",
      cwd: "/opt/axonaut-mcp",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      env: { NODE_ENV: "production" },
    },
  ],
};
