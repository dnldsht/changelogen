import { existsSync, promises as fsp } from "node:fs";
import type { Argv } from "mri";
import { resolve } from "pathe";
import consola from "consola";
import { execa } from "execa";
import {
  loadChangelogConfig,
  getGitDiff,
  parseCommits,
  bumpVersion,
  generateMarkDown,
} from "..";
import { githubRelease } from "./github";

export default async function defaultMain(args: Argv) {
  const cwd = resolve(args._[0] /* bw compat */ || args.dir || "");
  process.chdir(cwd);
  consola.wrapConsole();

  const config = await loadChangelogConfig(cwd, {
    from: args.from,
    to: args.to,
    output: args.output,
    newVersion: args.r,
  });

  const logger = consola.create({ stdout: process.stderr });
  logger.info(`Generating changelog for ${config.from || ""}...${config.to}`);

  const rawCommits = await getGitDiff(config.from, config.to);

  // Parse commits as conventional commits
  const commits = parseCommits(rawCommits, config).filter(
    (c) =>
      config.types[c.type] &&
      !(c.type === "chore" && c.scope === "deps" && !c.isBreaking)
  );

  // Bump version optionally
  if (args.bump || args.release) {
    let type;
    if (args.major) {
      type = "major";
    } else if (args.minor) {
      type = "minor";
    } else if (args.patch) {
      type = "patch";
    }
    const newVersion = await bumpVersion(commits, config, { type });
    if (!newVersion) {
      consola.error("Unable to bump version based on changes.");
      process.exit(1);
    }
    config.newVersion = newVersion;
  }

  // Generate markdown
  const markdown = await generateMarkDown(commits, config);

  // Show changelog in CLI unless bumping or releasing
  const displayOnly = !args.bump && !args.release;
  if (displayOnly) {
    consola.log("\n\n" + markdown + "\n\n");
  }

  // Update changelog file (only when bumping or releasing or when --output is specified as a file)
  if (typeof config.output === "string" && (args.output || !displayOnly)) {
    let changelogMD: string;
    if (existsSync(config.output)) {
      consola.info(`Updating ${config.output}`);
      changelogMD = await fsp.readFile(config.output, "utf8");
    } else {
      consola.info(`Creating  ${config.output}`);
      changelogMD = "# Changelog\n\n";
    }

    const lastEntry = changelogMD.match(/^###?\s+.*$/m);

    if (lastEntry) {
      changelogMD =
        changelogMD.slice(0, lastEntry.index) +
        markdown +
        "\n\n" +
        changelogMD.slice(lastEntry.index);
    } else {
      changelogMD += "\n" + markdown + "\n\n";
    }

    await fsp.writeFile(config.output, changelogMD);
  }

  // Commit and tag changes for release mode
  if (args.release) {
    if (args.commit !== false) {
      const filesToAdd = [config.output, "package.json"].filter(
        (f) => f && typeof f === "string"
      ) as string[];
      await execa("git", ["add", ...filesToAdd], { cwd });
      await execa(
        "git",
        ["commit", "-m", `chore(release): v${config.newVersion}`],
        { cwd }
      );
    }
    if (args.tag !== false) {
      await execa(
        "git",
        ["tag", "-am", "v" + config.newVersion, "v" + config.newVersion],
        { cwd }
      );
    }
    if (args.push === true) {
      await execa("git", ["push", "--follow-tags"], { cwd });
    }
    if (args.github !== false && config.repo?.provider === "github") {
      await githubRelease(config, {
        version: config.newVersion,
        body: markdown.split("\n").slice(2).join("\n"),
      });
    }
  }
}
