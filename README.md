# Walkthrough

Your companion for open homes and viewings.

**Step 1 (this version):** Trade Me sign-in and watchlist sync. Property listings on the member's watchlist are pulled in with open home times, price, photo and agent, and saved to the database.

## Getting it live

1. **GitHub Desktop:** File → Add Local Repository → choose this `walkthrough` folder → Create repository → Publish.
2. **Render:** New → Blueprint → pick the `walkthrough` repo. Render reads `render.yaml` and sets up the app and the database.
3. When Render asks, enter `TM_CONSUMER_KEY` and `TM_CONSUMER_SECRET`, the same values as the Homepage project.
4. Once the deploy finishes, open the `onrender.com` address on your phone.

Every time you push a change from GitHub Desktop, Render updates the app automatically.

## Notes

- `TM_ENV` is set to `production`. Change it to `sandbox` in Render to test against the Trade Me sandbox.
- Never commit your `.env` file. It's already excluded.
