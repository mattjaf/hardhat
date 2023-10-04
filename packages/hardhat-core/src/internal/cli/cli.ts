import chalk from "chalk";
import debug from "debug";
import "source-map-support/register";
import {
  TASK_COMPILE,
  TASK_HELP,
  TASK_TEST,
} from "../../builtin-tasks/task-names";
import { HardhatConfig, TaskArguments } from "../../types";
import { HARDHAT_NAME } from "../constants";
import { HardhatContext } from "../context";
import {
  getConfiguredCompilers,
  loadConfigAndTasks,
} from "../core/config/config-loading";
import {
  assertHardhatInvariant,
  HardhatError,
  HardhatPluginError,
} from "../core/errors";
import { ERRORS, getErrorCode } from "../core/errors-list";
import { isHardhatInstalledLocallyOrLinked } from "../core/execution-mode";
import { getEnvHardhatArguments } from "../core/params/env-variables";
import { HARDHAT_PARAM_DEFINITIONS } from "../core/params/hardhat-params";
import {
  getUserConfigPath,
  isCwdInsideProject,
} from "../core/project-structure";
import { Environment } from "../core/runtime-environment";
import { loadTsNode, willRunWithTypescript } from "../core/typescript-support";
import { Reporter } from "../sentry/reporter";
import { isRunningOnCiServer } from "../util/ci-detection";
import {
  getSecretsFilePath,
  hasConsentedTelemetry,
  hasPromptedForHHVSCode,
  writePromptedForHHVSCode,
  writeTelemetryConsent,
} from "../util/global-dir";
import { getPackageJson } from "../util/packageInfo";

import { saveFlamegraph } from "../core/flamegraph";
import { SecretsManager } from "../core/secrets/screts-manager";
import { Analytics } from "./analytics";
import { ArgumentsParser } from "./ArgumentsParser";
import { enableEmoji } from "./emoji";
import { createProject } from "./project-creation";
import { confirmHHVSCodeInstallation, confirmTelemetryConsent } from "./prompt";
import {
  InstallationState,
  installHardhatVSCode,
  isHardhatVSCodeInstalled,
} from "./hardhat-vscode-installation";

const log = debug("hardhat:core:cli");

const ANALYTICS_SLOW_TASK_THRESHOLD = 300;
const SHOULD_SHOW_STACK_TRACES_BY_DEFAULT = isRunningOnCiServer();

const secretsManager = new SecretsManager(getSecretsFilePath());

async function printVersionMessage() {
  const packageJson = await getPackageJson();
  console.log(packageJson.version);
}

async function suggestInstallingHardhatVscode() {
  const alreadyPrompted = hasPromptedForHHVSCode();
  if (alreadyPrompted) {
    return;
  }

  const isInstalled = isHardhatVSCodeInstalled();
  writePromptedForHHVSCode();

  if (isInstalled !== InstallationState.EXTENSION_NOT_INSTALLED) {
    return;
  }

  const installationConsent = await confirmHHVSCodeInstallation();

  if (installationConsent === true) {
    console.log("Installing Hardhat for Visual Studio Code...");
    const installed = installHardhatVSCode();

    if (installed) {
      console.log("Hardhat for Visual Studio Code was successfully installed");
    } else {
      console.log(
        "Hardhat for Visual Studio Code couldn't be installed. To learn more about it, go to https://hardhat.org/hardhat-vscode"
      );
    }
  } else {
    console.log(
      "To learn more about Hardhat for Visual Studio Code, go to https://hardhat.org/hardhat-vscode"
    );
  }
}

function showViaIRWarning(resolvedConfig: HardhatConfig) {
  const configuredCompilers = getConfiguredCompilers(resolvedConfig.solidity);
  const viaIREnabled = configuredCompilers.some(
    (compiler) => compiler.settings?.viaIR === true
  );

  if (viaIREnabled) {
    console.warn();
    console.warn(
      chalk.yellow(
        `Your solidity settings have viaIR enabled, which is not fully supported yet. You can still use Hardhat, but some features, like stack traces, might not work correctly.

Learn more at https://hardhat.org/solc-viair`
      )
    );
  }
}

async function main() {
  // We first accept this argument anywhere, so we know if the user wants
  // stack traces before really parsing the arguments.
  let showStackTraces =
    process.argv.includes("--show-stack-traces") ||
    SHOULD_SHOW_STACK_TRACES_BY_DEFAULT;

  try {
    const envVariableArguments = getEnvHardhatArguments(
      HARDHAT_PARAM_DEFINITIONS,
      process.env
    );

    const argumentsParser = new ArgumentsParser();

    const { hardhatArguments, scopeOrTaskName, allUnparsedCLAs } =
      argumentsParser.parseHardhatArguments(
        HARDHAT_PARAM_DEFINITIONS,
        envVariableArguments,
        process.argv.slice(2)
      );

    if (hardhatArguments.verbose) {
      Reporter.setVerbose(true);
      debug.enable("hardhat*");
    }

    if (hardhatArguments.emoji) {
      enableEmoji();
    }

    showStackTraces = hardhatArguments.showStackTraces;

    // --version is a special case
    if (hardhatArguments.version) {
      await printVersionMessage();
      return;
    }

    // ATTENTION! DEPRECATED CODE!
    // The command `npx hardhat`, when used to create a new Hardhat project, will be removed with Hardhat V3.
    // It will become `npx hardhat init`.
    // The code marked with the tag #INIT-DEP can be deleted after HarhatV3 is out.

    // Create a new Hardhat project
    if (scopeOrTaskName === "init") {
      return await createNewProject();
    }
    // #INIT-DEP - START OF DEPRECATED CODE
    else {
      if (
        scopeOrTaskName === undefined &&
        hardhatArguments.config === undefined &&
        !isCwdInsideProject()
      ) {
        await createNewProject();

        // Warning for Hardhat V3 deprecation
        console.warn(
          chalk.yellow.bold("\n\nDEPRECATION WARNING\n\n"),
          chalk.yellow(
            `Initializing a project with ${chalk.white.italic(
              "npx hardhat"
            )} is deprecated and will be removed in the future.\n`
          ),
          chalk.yellow(
            `Please use ${chalk.white.italic("npx hardhat init")} instead.\n\n`
          )
        );

        return;
      }
    }
    // #INIT-DEP - END OF DEPRECATED CODE

    // Tasks are only allowed inside a Hardhat project (except the init task)
    if (hardhatArguments.config === undefined && !isCwdInsideProject()) {
      throw new HardhatError(ERRORS.GENERAL.NOT_INSIDE_PROJECT);
    }

    if (scopeOrTaskName === "secrets" && allUnparsedCLAs.length > 1) {
      return await handleSecrets(allUnparsedCLAs);
    }

    if (
      process.env.HARDHAT_EXPERIMENTAL_ALLOW_NON_LOCAL_INSTALLATION !==
        "true" &&
      !isHardhatInstalledLocallyOrLinked()
    ) {
      throw new HardhatError(ERRORS.GENERAL.NON_LOCAL_INSTALLATION);
    }

    if (willRunWithTypescript(hardhatArguments.config)) {
      loadTsNode(hardhatArguments.tsconfig, hardhatArguments.typecheck);
    } else {
      if (hardhatArguments.typecheck === true) {
        throw new HardhatError(
          ERRORS.ARGUMENTS.TYPECHECK_USED_IN_JAVASCRIPT_PROJECT
        );
      }
    }

    const ctx = HardhatContext.createHardhatContext();

    const { resolvedConfig, userConfig } = loadConfigAndTasks(
      hardhatArguments,
      {
        showEmptyConfigWarning: true,
        showSolidityConfigWarnings: scopeOrTaskName === TASK_COMPILE,
      }
    );

    const envExtenders = ctx.environmentExtenders;
    const providerExtenders = ctx.providerExtenders;
    const taskDefinitions = ctx.tasksDSL.getTaskDefinitions();
    const scopesDefinitions = ctx.tasksDSL.getScopesDefinitions();

    // eslint-disable-next-line prefer-const
    let { scopeName, taskName, unparsedCLAs } =
      argumentsParser.parseScopeAndTaskNames(
        allUnparsedCLAs,
        taskDefinitions,
        scopesDefinitions
      );

    let telemetryConsent: boolean | undefined = hasConsentedTelemetry();

    const isHelpCommand = hardhatArguments.help || taskName === TASK_HELP;
    if (
      telemetryConsent === undefined &&
      !isHelpCommand &&
      !isRunningOnCiServer() &&
      process.stdout.isTTY === true &&
      process.env.HARDHAT_DISABLE_TELEMETRY_PROMPT !== "true"
    ) {
      telemetryConsent = await confirmTelemetryConsent();

      if (telemetryConsent !== undefined) {
        writeTelemetryConsent(telemetryConsent);
      }
    }

    const analytics = await Analytics.getInstance(telemetryConsent);

    Reporter.setConfigPath(resolvedConfig.paths.configFile);
    if (telemetryConsent === true) {
      Reporter.setEnabled(true);
    }

    const [abortAnalytics, hitPromise] = await analytics.sendTaskHit();

    let taskArguments: TaskArguments;

    // --help is a also special case
    if (hardhatArguments.help && taskName !== TASK_HELP) {
      // we "move" the task and scope names to the task arguments,
      // and run the help task
      if (scopeName !== undefined) {
        taskArguments = { scopeOrTask: scopeName, task: taskName };
      } else {
        taskArguments = { scopeOrTask: taskName };
      }
      taskName = TASK_HELP;
      scopeName = undefined;
    } else {
      const taskDefinition = ctx.tasksDSL.getTaskDefinition(
        scopeName,
        taskName
      );

      if (taskDefinition === undefined) {
        if (scopeName !== undefined) {
          throw new HardhatError(ERRORS.ARGUMENTS.UNRECOGNIZED_SCOPED_TASK, {
            scope: scopeName,
            task: taskName,
          });
        }
        throw new HardhatError(ERRORS.ARGUMENTS.UNRECOGNIZED_TASK, {
          task: taskName,
        });
      }

      if (taskDefinition.isSubtask) {
        throw new HardhatError(ERRORS.ARGUMENTS.RUNNING_SUBTASK_FROM_CLI, {
          name: taskDefinition.name,
        });
      }

      taskArguments = argumentsParser.parseTaskArguments(
        taskDefinition,
        unparsedCLAs
      );
    }

    const env = new Environment(
      resolvedConfig,
      hardhatArguments,
      taskDefinitions,
      scopesDefinitions,
      envExtenders,
      ctx.experimentalHardhatNetworkMessageTraceHooks,
      userConfig,
      providerExtenders
    );

    ctx.setHardhatRuntimeEnvironment(env);

    try {
      const timestampBeforeRun = new Date().getTime();

      await env.run({ scope: scopeName, task: taskName }, taskArguments);

      const timestampAfterRun = new Date().getTime();

      if (
        timestampAfterRun - timestampBeforeRun >
          ANALYTICS_SLOW_TASK_THRESHOLD &&
        taskName !== TASK_COMPILE
      ) {
        await hitPromise;
      } else {
        abortAnalytics();
      }
    } finally {
      if (hardhatArguments.flamegraph === true) {
        assertHardhatInvariant(
          env.entryTaskProfile !== undefined,
          "--flamegraph was set but entryTaskProfile is not defined"
        );

        const flamegraphPath = saveFlamegraph(env.entryTaskProfile);
        console.log("Created flamegraph file", flamegraphPath);
      }
    }

    // VSCode extension prompt for installation
    if (
      taskName === TASK_TEST &&
      !isRunningOnCiServer() &&
      process.stdout.isTTY === true
    ) {
      await suggestInstallingHardhatVscode();

      // we show the viaIR warning only if the tests failed
      if (process.exitCode !== 0) {
        showViaIRWarning(resolvedConfig);
      }
    }

    log(`Killing Hardhat after successfully running task ${taskName}`);
  } catch (error) {
    let isHardhatError = false;

    if (HardhatError.isHardhatError(error)) {
      isHardhatError = true;
      console.error(
        chalk.red.bold("Error"),
        error.message.replace(/^\w+:/, (t) => chalk.red.bold(t))
      );
    } else if (HardhatPluginError.isHardhatPluginError(error)) {
      isHardhatError = true;
      console.error(
        chalk.red.bold(`Error in plugin ${error.pluginName}:`),
        error.message
      );
    } else if (error instanceof Error) {
      console.error(chalk.red("An unexpected error occurred:"));
      showStackTraces = true;
    } else {
      console.error(chalk.red("An unexpected error occurred."));
      showStackTraces = true;
    }

    console.log("");

    try {
      Reporter.reportError(error as Error);
    } catch (e) {
      log("Couldn't report error to sentry: %O", e);
    }

    if (showStackTraces || SHOULD_SHOW_STACK_TRACES_BY_DEFAULT) {
      console.error(error);
    } else {
      if (!isHardhatError) {
        console.error(
          `If you think this is a bug in Hardhat, please report it here: https://hardhat.org/report-bug`
        );
      }

      if (HardhatError.isHardhatError(error)) {
        const link = `https://hardhat.org/${getErrorCode(
          error.errorDescriptor
        )}`;

        console.error(
          `For more info go to ${link} or run ${HARDHAT_NAME} with --show-stack-traces`
        );
      } else {
        console.error(
          `For more info run ${HARDHAT_NAME} with --show-stack-traces`
        );
      }
    }

    await Reporter.close(1000);
    process.exit(1);
  }
}

async function createNewProject() {
  if (isCwdInsideProject()) {
    throw new HardhatError(ERRORS.GENERAL.HARDHAT_PROJECT_ALREADY_CREATED, {
      hardhatProjectRootPath: getUserConfigPath(),
    });
  }

  if (
    process.stdout.isTTY === true ||
    process.env.HARDHAT_CREATE_JAVASCRIPT_PROJECT_WITH_DEFAULTS !== undefined ||
    process.env.HARDHAT_CREATE_TYPESCRIPT_PROJECT_WITH_DEFAULTS !== undefined
  ) {
    await createProject();
    return;
  }

  // Many terminal emulators in windows fail to run the createProject()
  // workflow, and don't present themselves as TTYs. If we are in this
  // situation we throw a special error instructing the user to use WSL or
  // powershell to initialize the project.
  if (process.platform === "win32") {
    throw new HardhatError(ERRORS.GENERAL.NOT_INSIDE_PROJECT_ON_WINDOWS);
  }

  throw new HardhatError(ERRORS.GENERAL.NOT_IN_INTERACTIVE_SHELL);
}

async function handleSecrets(args: string[]) {
  const [, action, key] = args;

  if (key === undefined && ["set", "get", "delete"].includes(action)) {
    throw new HardhatError(ERRORS.ARGUMENTS.INVALID_ARGUMENT_VALUE, {
      value: key,
      argument: "key",
      reason: `The key should not be undefined`,
    });
  }

  switch (action) {
    case "set": {
      return secretsManager.set(key, await getSecretValue());
    }
    case "get": {
      const secret = secretsManager.get(key);

      if (secret !== undefined) {
        console.log(secret);
      } else {
        console.log(
          chalk.yellow(`There is no secret associated to the key ${key}`)
        );
      }

      return;
    }
    case "list": {
      const keys = secretsManager.list();

      if (keys.length > 0) {
        keys.forEach((k) => console.log(k));
      } else {
        console.log(chalk.yellow(`There are no secrets in the secret manager`));
      }

      return;
    }
    case "delete": {
      const deleted = secretsManager.delete(key);

      if (!deleted) {
        console.log(
          chalk.yellow(`There is no secret associated to the key ${key}`)
        );
      }

      return;
    }
    default:
      throw new HardhatError(ERRORS.ARGUMENTS.INVALID_ARGUMENT_VALUE, {
        value: action,
        argument: "action",
        reason: `The action should be one of the following: set, get, list or delete`,
      });
  }
}

async function getSecretValue(): Promise<string> {
  const { default: enquirer } = await import("enquirer");

  const response: { secret: string } = await enquirer.prompt({
    type: "password",
    name: "secret",
    message: "Enter secret:",
  });

  if (response.secret.length === 0) {
    throw new HardhatError(ERRORS.ARGUMENTS.INVALID_ARGUMENT_VALUE, {
      value: "",
      argument: "secret",
      reason: `The secret should be a valid string`,
    });
  }

  return response.secret;
}

main()
  .then(() => process.exit(process.exitCode))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
