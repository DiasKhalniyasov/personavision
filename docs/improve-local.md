# Improve your site, locally

Run a test on your site, let Muse Wonder change your code from what the people in it did, check the change on the same people, and get a pull request. Everything runs on your machine, against your own repository. There is no GitHub App, and no hosting is needed.

## What you need

- This repository, built: `pnpm install && pnpm build`, plus a browser: `pnpm --filter @personavision/browser exec playwright install chromium`.
- `MODEL_API_KEY` in your environment. Muse Spark drives the people, and Muse Wonder writes the recommendations and the change.
- Your site's repository checked out, with a command that starts it locally and a command that checks it (build, tests).
- `gh` logged in, if you want the pull request opened for you.

## 1. Start your site and describe the people

Start your site locally, for example on `http://127.0.0.1:3000/`. Then write the audience to a file, for example `audience.json`:

```json
{
  "id": "early-career-builders",
  "name": "Software engineers 18-30 building products",
  "ageRange": { "min": 18, "max": 30 },
  "roles": ["Engineer at a startup", "Indie hacker with a pet project", "Founder building an MVP"],
  "regions": ["United States", "Germany", "India"],
  "goals": ["Make a product people notice", "Explain clearly what the product is for"],
  "devices": [
    { "name": "desktop", "viewport": { "width": 1440, "height": 900 }, "deviceScaleFactor": 2, "touch": false, "share": 0.6 },
    { "name": "mobile", "viewport": { "width": 390, "height": 844 }, "deviceScaleFactor": 3, "touch": true, "share": 0.4 }
  ],
  "techSavviness": 0.9,
  "priceSensitivity": 0.8,
  "size": 5,
  "generatedFrom": { "seed": 1, "generatorVersion": "persona-gen-1" }
}
```

## 2. Run the test

Use one sentence for the task and an observable criterion: a URL, a visible element or a piece of text.

```sh
node packages/cli/dist/cli.js run --site http://127.0.0.1:3000/ \
  --feature "understanding what the product is for" \
  --task "Find out what this product would do for your project and how you would start" \
  --criterion "The address bar reads /signup." \
  --audience audience.json --repeats 1 --seed 7 --engine model
```

The last line it prints is the run directory. To watch the people, open it with `node packages/cli/dist/cli.js open`: every person's replay, heatmaps, paths and what they thought at each step.

## 3. Let Wonder improve the site

```sh
pnpm improve:local runs/<run id> \
  --repo ~/code/my-site \
  --file src/pages/index.tsx --file src/pages/index.test.tsx \
  --check "pnpm build && pnpm test" \
  --serve "pnpm build && pnpm start --port {port}" --port 5199 \
  --pr
```

1. Wonder writes the run's recommendations, if it has none yet.
2. Wonder changes the files you named, one action at a time, on a new branch in a separate worktree (`<repo>-improve-<run id>`). Every turn it rereads the whole conversation so far: the test, each person's thoughts and actions, the recommendations, and each earlier action with its result. After every change, `--check` runs and its result is the next thing Wonder reads, so a broken build is fixed before the change is kept.
3. With `--serve`, the changed site is started on `--port`, and the same people, on the same seed, take the same test on it.
4. With `--pr`, the branch is pushed and a pull request is opened, with the change, the reasons and the before and after. It never merges.

The conversation is saved in the run directory as `improve-transcript.md`. Leave out `--pr` to look at the worktree first.

## Example: PersonaVision's own front page

```sh
node packages/cli/dist/cli.js serve --no-open            # the front page on http://127.0.0.1:5176/
node packages/cli/dist/cli.js run --site http://127.0.0.1:5176/ \
  --feature "understanding whether this tool helps you make your own product clear and noticeable" \
  --task "Find out whether PersonaVision could tell you if people understand what your own product is for, and how you would try it on your project" \
  --criterion "The address bar reads /signup." \
  --audience audience.json --repeats 1 --seed 7 --engine model
pnpm improve:local runs/<run id> \
  --file apps/viewer/src/screens/landing/LandingPage.tsx \
  --file apps/viewer/src/screens/landing/LandingPage.test.tsx \
  --file apps/viewer/src/screens/landing/landing.module.css \
  --check "pnpm --filter @personavision/viewer build && pnpm vitest run apps/viewer/src/screens/landing" \
  --serve "pnpm build >/dev/null && node packages/cli/dist/cli.js serve --no-open --port {port} --data-dir .personavision-preview" \
  --pr
```
