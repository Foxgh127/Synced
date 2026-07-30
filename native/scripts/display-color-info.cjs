const { app, screen } = require("electron");

app.whenReady().then(() => {
  process.stdout.write(`${JSON.stringify(screen.getAllDisplays())}\n`);
  app.quit();
});
