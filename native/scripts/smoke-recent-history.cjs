const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temporaryUserData = fs.mkdtempSync(
  path.join(os.tmpdir(), "synced-recent-history-"),
);
app.setPath("userData", temporaryUserData);

function withTimeout(promise, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function waitForLoad(window) {
  await new Promise((resolve, reject) => {
    window.webContents.once("did-finish-load", resolve);
    window.webContents.once("did-fail-load", (_event, code, description) => {
      reject(new Error(`renderer load failed (${code}): ${description}`));
    });
  });
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  try {
    await withTimeout(
      window.loadFile(
        path.join(__dirname, "..", "dist-renderer", "index.html"),
      ),
      "initial renderer load",
    );
    await withTimeout(
      window.webContents.executeJavaScript(`localStorage.setItem(
        "synced:recent-channels",
        JSON.stringify([{
          room: "TEST2345",
          name: "右键删除测试",
          signalUrl: "ws://47.98.173.139:8787/signal",
          lastJoinedAt: Date.now()
        }])
      )`),
      "history seed",
    );
    const reloaded = waitForLoad(window);
    window.webContents.reload();
    await withTimeout(reloaded, "renderer reload");
    window.setOpacity(0);
    window.showInactive();

    window.setContentSize(1100, 520);
    await new Promise((resolve) => setTimeout(resolve, 240));
    const homeLayout = await withTimeout(
      window.webContents.executeJavaScript(`(async () => {
         const main = document.querySelector(".home-main");
         const rail = document.querySelector(".channel-rail");
         const profile = document.querySelector(".home-profile-dock");
         const renameButton = document.querySelector(".home-profile-rename");
         const settingsButton = document.querySelector("[data-home-settings]");
         const starfield = document.querySelector("#star-canvas");
         const starFrameBefore = Number(starfield?.dataset.starFrame || 0);
         const profileBefore = profile?.getBoundingClientRect();
         if (main) main.scrollTop = main.scrollHeight;
         await new Promise((resolve) => setTimeout(resolve, 120));
         const starFrameAfter = Number(starfield?.dataset.starFrame || 0);
         const profileAfter = profile?.getBoundingClientRect();
         const copy = document.querySelector(".home-main")?.textContent || "";
         renameButton?.click();
         await new Promise((resolve) => setTimeout(resolve, 360));
         const profilePopover = document.querySelector("[data-profile-popover]");
         return {
          quickJoinSections:
            document.querySelectorAll(".recent-home-section").length,
          recentCards:
            document.querySelectorAll(".recent-home-section [data-recent-room]").length,
           sidebarRecentEntries:
             document.querySelectorAll(".channel-rail [data-recent-room]").length,
           sidebarAbsent: !rail,
           profileDockPresent: Boolean(profile),
           profilePopoverReady:
             Boolean(profilePopover) &&
             Boolean(profilePopover?.querySelector("[data-profile-nickname]")) &&
             !profilePopover?.querySelector("[data-open-settings]"),
           directSettingsReady:
             settingsButton instanceof HTMLButtonElement &&
             settingsButton !== renameButton,
           profilePosition: profile ? getComputedStyle(profile).position : "",
           profileLeft: profileAfter?.left || 0,
           profileBottomGap: profileAfter
             ? innerHeight - profileAfter.bottom
             : 999,
           profileTopDelta:
             profileBefore && profileAfter
               ? Math.abs(profileBefore.top - profileAfter.top)
               : 999,
           continueCardAbsent:
            !document.querySelector(".home-continue-card") &&
            !copy.includes("继续进入"),
          removedHeroCopyAbsent:
            !copy.includes("创建或加入一个最多 8 人的私人频道"),
          removedFooterAbsent:
            !copy.includes("服务器不保存影片") &&
            !copy.includes("隐私与媒体线路"),
          starfieldPresent:
            starfield instanceof HTMLCanvasElement &&
            Number(starfield.dataset.starCount || 0) >= 18,
          starfieldMoving: starFrameAfter > starFrameBefore,
          mainScrollTop: main?.scrollTop || 0,
          mainScrollable:
            Boolean(main) && main.scrollHeight > main.clientHeight,
          mainOverflowY: main ? getComputedStyle(main).overflowY : "",
           homeFrameColumns:
             getComputedStyle(document.querySelector(".home-frame"))
               .gridTemplateColumns,
           documentScrollTop:
            document.scrollingElement?.scrollTop || 0,
        };
      })()`),
      "home layout validation",
    );

    window.setContentSize(1100, 760);
    await new Promise((resolve) => setTimeout(resolve, 240));
    const profileCloseState = await window.webContents.executeJavaScript(
      `(async () => {
        const openProfile = document.querySelector(
          ".home-profile-rename[aria-expanded='true']"
        );
        const popover = document.querySelector("[data-profile-popover]");
        openProfile?.click();
        const deadline = performance.now() + 2_000;
        while (
          popover &&
          !popover.hidden &&
          performance.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        const main = document.querySelector(".home-main");
        main.style.scrollBehavior = "auto";
        main.scrollTop = 0;
        return {
          hidden: popover?.hidden === true,
          expanded: openProfile?.getAttribute("aria-expanded"),
        };
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const homeScreenshotPath = path.join(
      os.tmpdir(),
      "synced-home-smoke.png",
    );
    fs.writeFileSync(
      homeScreenshotPath,
      await window.webContents.capturePage().then((image) => image.toPNG()),
    );

    const settingsLayout = await withTimeout(
      window.webContents.executeJavaScript(`(async () => {
        const settingsTrigger = document.querySelector("[data-home-settings]");
        settingsTrigger?.click();
        const deadline = performance.now() + 2_000;
        while (
          !document.querySelector(".settings-dialog[open]") &&
          performance.now() < deadline
        ) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const dialog = document.querySelector(".settings-dialog[open]");
        dialog?.getAnimations({ subtree: true }).forEach((animation) => {
          try {
            animation.finish();
          } catch {}
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const nav = dialog?.querySelector(".settings-nav");
        const content = dialog?.querySelector(".settings-content");
        const rect = dialog?.getBoundingClientRect();
        const dialogStyle = dialog ? getComputedStyle(dialog) : undefined;
        return {
          open: Boolean(dialog),
          openedByDirectSettings:
            settingsTrigger instanceof HTMLButtonElement,
          presence: dialog?.dataset.presence || "",
          display: dialogStyle?.display || "",
          visibility: dialogStyle?.visibility || "",
          opacity: Number(dialogStyle?.opacity || "0"),
          modalOpen: document.body.dataset.modalOpen || "",
          labels: [...(nav?.querySelectorAll("[data-settings-tab]") || [])]
            .map((tab) => tab.textContent?.trim()),
          navDisplay: nav ? getComputedStyle(nav).display : "",
          contentOverflowY: content
            ? getComputedStyle(content).overflowY
            : "",
          width: rect?.width || 0,
          height: rect?.height || 0,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          compactControlsAbsent: [
            "#setting-effects",
            "#setting-motion",
            "#setting-transparency",
            "#setting-ambient",
            "#settings-panel-advanced",
          ].every((selector) => !dialog?.querySelector(selector)),
          commonHeading:
            dialog?.querySelector("#settings-panel-appearance h3")
              ?.textContent?.trim() || "",
        };
      })()`),
      "settings layout validation",
    );
    await new Promise((resolve) => setTimeout(resolve, 420));
    const settingsScreenshotPath = path.join(
      os.tmpdir(),
      "synced-settings-smoke.png",
    );
    window.setOpacity(0);
    window.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 120));
    fs.writeFileSync(
      settingsScreenshotPath,
      await window.webContents.capturePage().then((image) => image.toPNG()),
    );
    window.hide();
    window.setOpacity(1);
    await window.webContents.executeJavaScript(
      "document.querySelector('.settings-dialog[open] [data-dialog-close]')?.click()",
    );

    const result = await withTimeout(
      window.webContents.executeJavaScript(`(async () => {
      const button = document.querySelector("[data-recent-room='TEST2345']");
      const openMenu = () => button?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2
      }));
      const count = () =>
        JSON.parse(localStorage.getItem("synced:recent-channels") || "[]").length;

      openMenu();
      const openedByRightClick = Boolean(
        document.querySelector("[data-recent-delete-dialog]")
      );
      const unchangedBeforeChoice = count() === 1;
      document.querySelector("[data-cancel-recent-delete]")?.click();
      const closeDeadline = performance.now() + 2_000;
      while (
        document.querySelector("[data-recent-delete-dialog]") &&
        performance.now() < closeDeadline
      ) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const cancelKeptHistory =
        count() === 1 &&
        !document.querySelector("[data-recent-delete-dialog]");

      openMenu();
      document.querySelector("[data-confirm-recent-delete]")?.click();
      return {
        openedByRightClick,
        unchangedBeforeChoice,
        cancelKeptHistory,
        confirmRemovedHistory:
          count() === 0 &&
          !document.querySelector("[data-recent-room='TEST2345']")
      };
    })()`),
      "right-click interaction",
    );

    if (
      Object.values(result).some((value) => value !== true) ||
      homeLayout.quickJoinSections !== 1 ||
      homeLayout.recentCards !== 1 ||
       homeLayout.sidebarRecentEntries !== 0 ||
       !homeLayout.sidebarAbsent ||
       !homeLayout.profileDockPresent ||
       !homeLayout.profilePopoverReady ||
       !homeLayout.directSettingsReady ||
       homeLayout.profilePosition !== "fixed" ||
       homeLayout.profileLeft < 0 ||
       homeLayout.profileBottomGap < 0 ||
       homeLayout.profileTopDelta > 1 ||
       !homeLayout.continueCardAbsent ||
      !homeLayout.removedHeroCopyAbsent ||
      !homeLayout.removedFooterAbsent ||
      !homeLayout.starfieldPresent ||
      !homeLayout.starfieldMoving ||
      !homeLayout.mainScrollable ||
       homeLayout.mainScrollTop <= 0 ||
       homeLayout.mainOverflowY !== "auto" ||
      homeLayout.homeFrameColumns.split(" ").length !== 1 ||
      homeLayout.documentScrollTop !== 0 ||
      !profileCloseState.hidden ||
      profileCloseState.expanded !== "false" ||
      !settingsLayout.open ||
      !settingsLayout.openedByDirectSettings ||
      settingsLayout.presence !== "present" ||
      settingsLayout.display !== "block" ||
      settingsLayout.visibility !== "visible" ||
      settingsLayout.opacity < 0.99 ||
      settingsLayout.modalOpen !== "true" ||
      settingsLayout.labels.join(",") !== "常用,网络,Emby,关于" ||
      settingsLayout.navDisplay !== "flex" ||
      settingsLayout.contentOverflowY !== "auto" ||
      settingsLayout.width > settingsLayout.viewportWidth ||
      settingsLayout.height > settingsLayout.viewportHeight ||
      !settingsLayout.compactControlsAbsent ||
      settingsLayout.commonHeading !== "常用设置"
    ) {
      throw new Error(
        `home/settings/history validation failed: ${JSON.stringify({
          homeLayout,
          profileCloseState,
          settingsLayout,
          result,
        })}`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        homeScreenshotPath,
        settingsScreenshotPath,
        profileCloseState,
        homeLayout,
        settingsLayout,
        ...result,
      })}\n`,
    );
  } finally {
    window.destroy();
  }
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });
