#!/usr/bin/env node

import { Command } from 'commander';
import prompts from 'prompts';
import ora from 'ora';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import updateNotifier from 'update-notifier';
import { Validator } from 'jsonschema';
import { c as createTarball } from 'tar';

let version = 'v1.0.1';
const pkg = {
    name: '@homeview/cli',
    version,
};

const notifier = updateNotifier({ pkg, shouldNotifyInNpmScript: true });
notifier.notify();

const SCHEMA = {
    type: 'object',
    properties: {
        app_name: { type: 'string', required: true },
        package_name: { type: 'string', required: true },
        version: { type: 'string', required: true },
        description: { type: 'string', optional: true },
        vendor: { type: 'string', optional: true },
        homepage: { type: 'string', optional: false },
        icon: { type: 'string', optional: false },
        background_color: { type: 'string', optional: false },
        app_url: { type: 'string', optional: true },
        app_local_url: { type: 'string', optional: true },
        service_script: { type: 'string', optional: false },
        launch_script: { type: 'string', optional: false },
        pre_install_script: { type: 'string', optional: false },
        post_install_script: { type: 'string', optional: false },
        package_type: { type: 'string', enum: ['HPK'], required: true },
        debug_mode: { type: 'boolean', optional: true },
        assets: { type: 'array', items: { type: 'string' }, optional: false },
        scripts: { type: 'string', optional: false }
    }
};

function handleInterrupt(msg) {
    console.log(chalk.red(`${msg}`));
    process.exit(0);
}

async function gatherAppInfo(schema) {
    const promptsArray = [];
    const addPrompt = (name, message, type, validate, choices) => {
        promptsArray.push({
            type: type || 'text',
            name: name,
            message: message,
            validate: validate,
            choices: choices,
            initial: type === 'text' ? '' : undefined
        });
    };

    const iterateProperties = (properties) => {
        for (const [key, value] of Object.entries(properties)) {
            const message = `${key.replace(/_/g, ' ')}${value.required ? ' (required)' : ''}`;
            const validate = value.required
                ? (v) => (v && v.trim() !== '' ? true : `${key} is required.`)
                : undefined;

            if (value.type === 'string') {
                if (key === 'package_type') {
                    addPrompt(key, message, 'select', validate, [
                        { title: 'HPK', value: 'HPK' }
                    ]);
                } else if (key === 'app_url' || key === 'app_local_url') {
                    // These will be handled conditionally
                } else if (value.optional || value.required) {
                    addPrompt(key, message, 'text', validate);
                }
            } else if (value.type === 'boolean') {
                if (value.optional) {
                    addPrompt(key, message, 'toggle', validate, [
                        { title: 'Yes', value: true },
                        { title: 'No', value: false }
                    ]);
                }
            } else if (value.type === 'array') {
                if (value.optional) {
                    addPrompt(key, message, 'text', validate);
                }
            } else if (value.type === 'object') {
                iterateProperties(value.properties);
            }
        }
    };

    iterateProperties(schema.properties);

    promptsArray.splice(
        promptsArray.findIndex(p => p.name === 'app_url') || promptsArray.length,
        0,
        {
            type: 'select',
            name: 'app_type',
            message: 'app type',
            choices: [
                { title: 'online (web url)', value: 'online' },
                { title: 'offline (local url)', value: 'offline' }
            ],
            initial: 0
        }
    );

    const onCancel = (prompt, answers) => {
        handleInterrupt('Initialization cancelled.');
        process.exit(0);
    };

    const responses = await prompts(promptsArray, { onCancel });

    const result = {};
    for (const [key, value] of Object.entries(responses)) {
        result[key] = value;
    }

    if (responses.app_type === 'online') {
        result.app_url = '';
        result.app_local_url = '<does-not-apply>';
    } else if (responses.type === 'offline') {
        result.app_url = '<does-not-apply>';
        result.app_local_url = '';
    }

    for (const [key, value] of Object.entries(schema.properties)) {
        if (!(key in result)) {
            result[key] = value.type === 'array' ? [] : '';
        }
    }

    return result;
}

async function buildThread(config, buildPath, configPath) {
    const configDir = path.dirname(configPath);
    const archivePath = path.resolve(buildPath, `${config.package_name}.hpk`);
    const tarballPath = path.resolve(buildPath, `${config.package_name}_package.tmp`);

    fs.ensureDirSync(buildPath);
    if (fs.existsSync(tarballPath)) {
        fs.removeSync(tarballPath);
    }
    if (fs.existsSync(archivePath)) {
        fs.removeSync(archivePath);
    }

    const filesToArchive = [];
    const files = fs.readdirSync(configDir);
    for (const file of files) {
        const fullPath = path.join(configDir, file);
        if (file === 'node_modules') continue; // Skip node_modules
        if (fs.statSync(fullPath).isDirectory()) {
            const subFiles = fs.readdirSync(fullPath);
            for (const subFile of subFiles) {
                const subFilePath = path.join(fullPath, subFile);
                if (fs.statSync(subFilePath).isFile()) {
                    filesToArchive.push(subFilePath);
                }
            }
        } else {
            filesToArchive.push(fullPath);
        }
    }

    await createTarball({
        gzip: true,
        file: tarballPath,
        cwd: configDir
    }, filesToArchive);

    const tarballContent = fs.readFileSync(tarballPath);
    const archiveStream = fs.createWriteStream(archivePath);
    const header = `# Start of ${config.package_name}\n# Packaged by homeview-cli ${config.version}\n`;
    archiveStream.write(header);
    archiveStream.write(tarballContent);
    const footer = `# End of ${config.package_name}\n`;
    archiveStream.write(footer);
    archiveStream.end();
    await new Promise((resolve, reject) => {
        archiveStream.on('finish', resolve);
        archiveStream.on('error', reject);
    });
    fs.removeSync(tarballPath);
    return fs.statSync(archivePath).size;
}

function saveConfig(filePath, config) {
    fs.writeJsonSync(filePath, config, { spaces: 2 });
    console.log(chalk.green(`√ Config saved to ${filePath}`));
}

function loadConfig(filePath) {
    if (!fs.existsSync(filePath)) {
        console.error(chalk.red(`× Config file ${filePath} does not exist.`));
        process.exit(1);
    }

    const config = fs.readJsonSync(filePath);
    const validator = new Validator();
    const result = validator.validate(config, SCHEMA);

    if (result.errors.length > 0) {
        console.error(`${chalk.red('×')} Invalid config:`);
        result.errors.forEach(error => console.error(chalk.red(`- ${error.stack}`)));
        process.exit(1);
    }

    console.log(chalk.green(`√ Config loaded from ${filePath}`));
    return config;
}

async function startBuild(config, configPath) {
    const buildPath = path.resolve(process.cwd(), 'build');
    const startTime = Date.now();
    const spinner = ora('Building...').start();

    let minutes, seconds;
    let canceled = false;

    fs.ensureDirSync(buildPath);

    const handleInterrupt = () => {
        canceled = true;
        spinner.stopAndPersist({
            symbol: chalk.yellow('!'),
            text: `Build cancelled by user.`
        });
        process.exit(0);
    };
    process.on('SIGINT', handleInterrupt);

    try {
        for (let i = 0; i <= 100; i += 10) {
            if (canceled) return;
            await new Promise(resolve => setTimeout(resolve, 100));
            const elapsed = Date.now() - startTime;
            minutes = Math.floor(elapsed / 60000);
            seconds = Math.floor((elapsed % 60000) / 1000);
            const timeString = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            spinner.text = `Building ${config.package_name}... (${timeString})`;
        }

        const buildSizeBytes = await buildThread(config, buildPath, configPath);
        //console.log(buildSizeBytes);
        const buildSize = buildSizeBytes >= 1024 * 1024
            ? `${(buildSizeBytes / (1024 * 1024)).toFixed(2)} MB`
            : `${(buildSizeBytes / 1024).toFixed(2)} KB`;
        //console.log(buildSize);

        spinner.stopAndPersist({
            symbol: chalk.green('√'),
            text: `Build complete! (${minutes > 0 ? `${minutes}m ` : ''}${seconds}s)\n${chalk.green('+')} Final size: ${buildSize}`
        });
    } catch (err) {
        if (canceled) return;
        spinner.stopAndPersist({
            symbol: chalk.red('×'),
            text: `Build failed:\n${chalk.white(`${err.message}`)}`
        });
    }
}

const program = new Command();
program
    .name('homeview-cli')
    .version(version)
//.option('-d, --debug', 'output debug information');

program
    .command('init')
    .description('initialize a new project')
    .action(async () => {
        try {
            const filePath = path.resolve(process.cwd(), 'homeview.json');
            if (fs.existsSync(filePath)) {
                const response = await prompts({
                    type: 'confirm',
                    name: 'overwrite',
                    message: 'Config file already exists. Do you want to overwrite it?',
                    initial: false
                });

                if (!response.overwrite) {
                    console.log(chalk.red('Initialization canceled.'));
                    return;
                }
            }
            const appInfo = await gatherAppInfo(SCHEMA);
            saveConfig(filePath, appInfo);
        } catch (error) {
            console.error(chalk.red('An error occurred during initialization.'));
        }
    });

program
    .command('build')
    .description('build an existing project')
    .action(async () => {
        const filePath = path.resolve(process.cwd(), 'homeview.json');
        const config = loadConfig(filePath);
        await startBuild(config, filePath);
    });

program
    .command('help')
    .description('display help information')
    .action(() => {
        program.help();
    });

program.parse(process.argv);