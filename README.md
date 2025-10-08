This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## HunterLab Changelog Web

A changelog website for HunterLab products, including Desktop, Instrument (Agera, ColorFlex, Vista), and Recovery software.

### Features

- **Multiple Instrument Models**: Separate changelogs for Agera, ColorFlex, and Vista instruments
- **Release Channels**: Toggle between Production and Preview releases
- **Navigation Dropdown**: Intuitive instrument model selection
- **Markdown Support**: Rich release notes with full markdown rendering
- **Pagination**: Clean browsing experience for release history
- **Timeline View**: Visual timeline for releases

### Environment Variables

Set `NEXT_PUBLIC_UPDATE_BASE_URL` to point to your update server API endpoint.

```bash
NEXT_PUBLIC_UPDATE_BASE_URL=http://hl-essentials-update-24423.azurewebsites.net
```

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### Routes

- `/desktop` - Desktop application changelog
- `/instrument/agera` - Agera instrument changelog
- `/instrument/colorflex` - ColorFlex instrument changelog
- `/instrument/vista` - Vista instrument changelog
- `/recovery` - Recovery software changelog

Add `?channel=preview` to any route to view preview releases.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
