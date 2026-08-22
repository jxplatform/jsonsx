---
title: "Privacy Policy — Jx Suite"
$head:
  - tagName: meta
    attributes:
      name: description
      content: "How Avunu LLC handles personal data across the Jx Suite website, the open-source Jx Studio app, and the hosted Jx Publishing Platform. No tracking, no analytics, no sale of personal data."
  - tagName: meta
    attributes:
      property: "og:title"
      content: "Jx Suite Privacy Policy"
  - tagName: meta
    attributes:
      property: "og:description"
      content: "What we collect, why, how long we keep it, and the rights you have over it."
  - tagName: meta
    attributes:
      name: robots
      content: "index, follow"
$elements:
  - "$ref": "../components/section-label.json"
---

::::div{style.padding="clamp(4rem, 8vw, 6rem) clamp(1rem, 3vw, 2rem) clamp(3rem, 6vw, 4rem)"} :::div{style.maxWidth="46rem" style.margin="0 auto"}

::section-label{props.text="Legal"}

# Privacy Policy

**Effective date:** 21 August 2026\
**Last updated:** 21 August 2026

This policy explains what personal data Avunu LLC handles when you use Jx Suite, why we handle it, how long we keep it, and what you can require of us.

Jx Suite spans three quite different things, and the honest answer to "what do you collect?" is different for each. Section 2 tells you which one you are using; sections 4 to 6 cover each in turn.

## 1\. Who we are

**Avunu LLC** ("Avunu", "we", "us") is a Pennsylvania limited liability company and the owner and operator of Jx Suite, which comprises the jxsuite.com website, the Jx Studio desktop application and `jx` command-line tools, the open-source `@jxsuite/*` packages, and the hosted Jx Publishing Platform at studio.jxsuite.com.

Avunu LLC is the **data controller** for the processing described in this policy.

- **Postal address:** 948 E Philadelphia St, York Pennsylvania 17403, United States
- **Privacy contact:** [m](mailto:privacy@jxsuite.com)a

If you are in the European Economic Area or the United Kingdom, see section 14 for the rights that apply to you and how to exercise them.

## 2\. Which part of Jx Suite are you using?

| What you are using                                             | Who runs it                       | What reaches Avunu                                                                                              |
| -------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| jxsuite.com — the marketing site and documentation             | GitHub                            | Nothing beyond standard web-server request logs. No analytics, no trackers, no cookies.                         |
| Jx Studio desktop app, the jx CLI, and the @jxsuite/* packages | You, on your own device or server | Nothing. The software contains no telemetry and no analytics. It has no account and phones no home.             |
| Jx Publishing Platform — studio.jxsuite.com                    | Us                                | Your GitHub identity, your project working files while you edit them, and the operational records in section 6. |
| A website you built with Jx and its visitors                   | You                               | Nothing. See section 9.                                                                                         |

## 3\. Things we do not do

These are commitments, not omissions:

- We do **not** sell your personal information, and we do **not** share it for cross-context behavioural advertising, as those terms are defined under California law.
- We run **no** advertising, and we serve no advertising or marketing trackers on any surface.
- We embed **no** third-party analytics — no page-view counters, no session recording, no fingerprinting, no tag managers — on jxsuite.com, in Jx Studio, or in the Publishing Platform.
- The open-source Jx software contains **no** telemetry, crash reporting, or usage measurement of any kind. You can verify this: the source is public and MIT licensed.
- We do **not** use your project content, your prompts, or your AI conversations to train any model, our own or anyone else's.
- We do **not** make decisions about you by automated means that produce legal or similarly significant effects.

## 4\. The jxsuite.com website

jxsuite.com is a static site. It sets **no cookies**, uses no local storage, and runs no analytics.

**Site search.** The search box on jxsuite.com is built by `@jxsuite/search` at compile time into a single JSON file. Your browser downloads that file once and answers every query locally. Search terms are never transmitted anywhere.

**Server logs.** Like any website, jxsuite.com is served by a hosting provider that keeps short-lived request logs — IP address, timestamp, requested URL, user agent, and referrer — to deliver pages and to defend against abuse and denial-of-service traffic. Our legal basis is our legitimate interest in operating and securing the site (GDPR Article 6(1)(f)). We do not use these logs to build profiles, and we do not join them to any account.

**Outbound links.** Pages link to GitHub, npm, and other third-party sites. Following such a link takes you to a service with its own privacy policy, which we do not control.

## 5\. Jx Studio, the `jx` CLI, and the `@jxsuite/*` packages

This is open-source software you download and run yourself. **It sends nothing to Avunu.** There is no account, no licence check, no activation, no usage measurement. Your projects are plain files on your own disk.

### 5.1 What Jx Studio stores on your device

Studio keeps preferences and working state in your browser's or the app's local storage, on your machine:

- Recently opened projects and files
- Theme, panel layout, and recent commands
- AI chat history, scoped per project
- Any AI provider API key and endpoint you enter
- Any Cloudflare API token you enter
- A GitHub access token, if you choose to connect GitHub

On the desktop app, credentials are held by the native launcher rather than left readable by the web view between sessions. **Preferences → Reset Studio data** removes every key Studio owns.

### 5.2 Connections Jx Studio makes, at your direction

Jx Studio talks to third parties only when you ask it to, and always directly — the traffic does not pass through Avunu:

- **Update checks.** The desktop app checks in the background for a newer release at `github.com/jxsuite/jx/releases`. That request necessarily discloses your IP address, approximate location, and the app version to GitHub. There is no separate Avunu update server, and we receive no record of the check. You can prevent it by blocking the app's network access or installing releases manually.
- **GitHub sign-in.** If you connect GitHub, Studio performs GitHub's device authorization flow and stores the resulting token locally. Your credentials go to GitHub, never to us.
- **AI providers.** If you configure an AI provider in the desktop or CLI tools, your prompts and project context go from your machine straight to the endpoint you named, under your own API key and your own agreement with that provider.
- **Package installs.** Installing packages contacts the npm registry, as any package manager does.

## 6\. Jx Publishing Platform (studio.jxsuite.com)

The Publishing Platform is our hosted service. It is the part of Jx Suite where we do process personal data about you, and it is deliberately narrow: GitHub holds your code and decides your permissions, your own Cloudflare account performs your deployments and your AI inference, and our service brokers between them.

### 6.1 Account and identity

You sign in with GitHub. When you do, we record from your GitHub profile:

| Field                                               | Purpose                                     |
| --------------------------------------------------- | ------------------------------------------- |
| GitHub numeric user id                              | Stable account key                          |
| GitHub login                                        | Attribution, collaborator presence, support |
| Display name                                        | Interface labelling                         |
| Avatar URL                                          | Interface labelling                         |
| Account creation and most recent sign-in timestamps | Account lifecycle, abuse investigation      |

We never receive your GitHub password. We do not ask for your email address, and we do not send marketing email.

**Legal basis:** performance of our contract with you (GDPR Article 6(1)(b)).

### 6.2 Sessions and cookies

The Publishing Platform sets exactly one cookie:

| Cookie     | Purpose                 | Properties                                                       | Lifetime                                  |
| ---------- | ----------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| jx_session | Keeps you authenticated | Opaque random identifier; HttpOnly, Secure, SameSite=Lax, Path=/ | 30 days, extended while you remain active |

This is a strictly necessary cookie: without it the service cannot tell one request from another. It carries no profile data — the identifier points to a server-side record holding your user id, your GitHub login, and your **encrypted** GitHub access and refresh tokens. Signing out deletes that record and clears the cookie.

We set no analytics, preference, or advertising cookies, so there is no consent banner to click through.

### 6.3 Your GitHub connection

Projects **are** GitHub repositories, and permissions are entirely GitHub's. The "Jx Suite" GitHub App holds whatever repository access you granted it, and every write we make on your behalf uses your own user token, so commits are attributed to you.

We store your GitHub access and refresh tokens encrypted with AES-256-GCM in a server-side session record. We also keep a small metadata cache per project — repository id, owner, name, default branch, whether it is a Jx project, its `project.json` configuration, any linked Cloudflare Pages project, who opened it first, and when it was last opened — so the project list loads quickly. That cache is never authoritative; GitHub is.

You can revoke our access at any time from your GitHub settings, under **Applications → Installed GitHub Apps**. Doing so ends our ability to read or write your repositories.

### 6.4 Your Cloudflare connection (optional)

Publishing and AI assistance run on **your own Cloudflare account**, not ours, and bill to you. If you connect Cloudflare, we broker an OAuth authorization and store:

- Your Cloudflare account id and account name
- Your access and refresh tokens, encrypted with AES-256-GCM
- The scopes you granted and the token expiry

We request the narrowest scopes the features need: read your account list, read and write Cloudflare Pages, and read Workers AI. Our request proxy accepts a fixed allowlist of Cloudflare API paths — account listing, Pages projects, and Pages deployments — and rejects everything else, so the connection cannot be used to reach the rest of your Cloudflare account.

Disconnecting Cloudflare in the app revokes the token at Cloudflare and deletes the stored record.

**Legal basis:** performance of our contract with you (Article 6(1)(b)).

### 6.5 Your project content

While you edit a project in the cloud, we hold a **working tree** for that repository and branch: a copy of the files you have opened, plus your uncommitted changes. Text lives in an isolated per-branch datastore; binary files live in object storage. Commits are written straight to GitHub using your own token, so GitHub is always the source of truth.

After a branch has been inactive for 24 hours, we drop our cached copies of files that match what is already on GitHub; they are refetched from GitHub the next time someone opens the branch. Changes you have **not** committed are never dropped by that cleanup — they remain until you commit or discard them, because losing them would lose your work.

Project files may of course contain personal data that you put there — an author biography, a customer testimonial, a photograph. You control what goes into your repository. When you handle other people's personal data in a project, you are that data's controller and we handle it on your instructions.

We do not read your project content except as required to serve your own editing session, and it is never used for any other purpose.

### 6.6 Real-time collaboration

Everyone editing the same branch shares one working tree. To make that legible, the service relays **presence** information between collaborators on that branch: your GitHub login, an assigned colour, and where your cursor and selection are. It is relayed live to your collaborators and is not retained after you disconnect. For the life of each connection we also hold the socket's identifier, the login it belongs to, and its GitHub permission level.

If you do not want collaborators to see your activity, do not open a shared branch.

### 6.7 AI assistance

AI requests from the cloud editor pass through our service to one of two places:

1.  **Workers AI on your own Cloudflare account** (the default), using the token from section 6.4. Inference happens under your Cloudflare agreement and bills to you.
2.  **Your own AI provider**, if you supply an API key. The key is forwarded upstream with the request and **is never stored by us**.

Either way we are a conduit. **Prompts, project context, and model responses pass through in transit and are not retained by us.** They are subject to the privacy terms of the provider that answers — Cloudflare's for Workers AI, or your chosen provider's — and you should read those, because we cannot make commitments on their behalf.

What we do keep is a metadata record of the request: the timestamp, your user id, the model name, how many messages were in the conversation, and whether you used your own key. Message **content** is not recorded.

### 6.8 Operational records

| Record                 | Contents                                                                                                                                         | Purpose                                                                | Retention                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------- |
| Audit log              | Timestamp, user id, action (for example auth.login, cf.disconnect), affected resource, and a short metadata note — never file or message content | Security, abuse investigation, answering "what happened to my project" | 12 months                       |
| AI rate-limit counters | Your user id and a per-day request count                                                                                                         | Enforcing per-minute and per-day request limits                        | 48 hours, then automatic expiry |
| GitHub webhook events  | Repository push and deletion notifications from GitHub                                                                                           | Keeping working trees current; purging data for deleted repositories   | Processed and discarded         |

Application request logging is **disabled** in our production service configuration. Our infrastructure provider retains its own edge logs for network operation and security under its own terms.

**Legal basis:** our legitimate interest in operating a secure and abuse-resistant service (Article 6(1)(f)), and in the case of records we must keep, compliance with a legal obligation (Article 6(1)(c)).

## 7\. Cookies and similar technologies, in summary

| Surface                   | Cookies                             | Local storage                                                   | Third-party trackers |
| ------------------------- | ----------------------------------- | --------------------------------------------------------------- | -------------------- |
| jxsuite.com               | None                                | None                                                            | None                 |
| Jx Studio (desktop / CLI) | None                                | Yes — preferences and credentials, on your device (section 5.1) | None                 |
| Jx Publishing Platform    | One, jx_session, strictly necessary | Yes — editor preferences, on your device                        | None                 |

Because we set no non-essential cookies and run no trackers, there is nothing here to consent to or withdraw. Global Privacy Control and Do Not Track signals require no action from us, as we already do not engage in the tracking or selling they are designed to stop.

## 8\. Who we share data with

We disclose personal data to a small set of service providers, each acting on our instructions or under your own direct relationship with them. We do not disclose personal data to anyone for money or for advertising.

| Recipient                | What it receives                                                                                          | Why                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare, Inc.         | Hosting, storage, and network delivery for the Publishing Platform and jxsuite.com; edge request metadata | Infrastructure processor. Where you connect your own Cloudflare account, Cloudflare is additionally an independent controller under your agreement with it. |
| GitHub, Inc. (Microsoft) | Your sign-in, your repositories, your commits                                                             | Identity and source of truth. GitHub is an independent controller for your GitHub account.                                                                  |
| Your chosen AI provider  | Prompts and project context you send, under your own key                                                  | Only if you configure one. Independent controller under your agreement with it.                                                                             |
| npm / registry hosts     | Package requests from your own machine                                                                    | Only when you install packages.                                                                                                                             |

We may also disclose personal data where we are legally required to — to comply with a valid legal process, to enforce our terms, or to protect the rights, safety, or property of Avunu, our users, or the public. If Avunu is involved in a merger, acquisition, or sale of assets, personal data may transfer as part of that transaction; we will give notice before your data becomes subject to a different privacy policy.

## 9\. Websites you build with Jx (you are the controller)

If you use `@jxsuite/auth`, `@jxsuite/connector`, or any other extension to collect data from your own site's visitors — sign-ups, comments, form submissions, orders — that data flows to **your** database on **your** infrastructure, under **your** database credentials. It does not pass through Avunu and we never see it.

For that data you are the controller. You are responsible for your own privacy notice, your own lawful basis, your own consent mechanics, and your own responses to the requests your visitors make of you. We provide the software; we do not process the data it moves.

## 10\. International transfers

Avunu LLC is based in the United States, and our infrastructure providers operate global networks, so personal data may be processed in the United States and in other countries.

Where we transfer personal data out of the EEA, the United Kingdom, or Switzerland, we rely on the European Commission's Standard Contractual Clauses (and the UK International Data Transfer Addendum where applicable), incorporated into our agreements with the providers named in section 8. You may request a copy of the relevant safeguards by writing to [privacy@jxsuite.com](mailto:privacy@jxsuite.com).

## 11\. How long we keep things

| Data                                               | Retention                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Account record (GitHub id, login, name, avatar)    | Until you ask us to delete your account, then removed within 30 days                |
| Session records and GitHub tokens                  | 30 days from last activity, then automatic expiry; immediately on sign-out          |
| Cloudflare connection and tokens                   | Until you disconnect, or your account is deleted                                    |
| Project metadata cache                             | Until the repository is deleted or disconnected, whichever comes first              |
| Cached copies of files already committed to GitHub | Dropped after 24 hours of branch inactivity, then refetched from GitHub on next use |
| Uncommitted changes in a working tree              | Until you commit them to GitHub or discard them                                     |
| Collaboration presence                             | Not retained — discarded on disconnect                                              |
| AI prompts and responses                           | Not retained                                                                        |
| AI request metadata and rate-limit counters        | 48 hours for counters; 12 months for the audit record                               |
| Audit log                                          | 12 months                                                                           |

Deleting a repository on GitHub causes us to purge its cached project record and its working-tree sessions.

## 12\. Security

- Third-party tokens are encrypted at rest with AES-256-GCM under a key held in our secret store and versioned for rotation, never in our database or source code.
- The session cookie is `HttpOnly`, `Secure`, and `SameSite=Lax`, and mutating requests are checked against the expected origin.
- Authorization is delegated to GitHub rather than reimplemented: if you cannot write a repository on GitHub, you cannot write it through us.
- Our request proxy is allowlisted to specific API paths, so a connected account cannot be reached beyond the features you enabled.
- Our service does not execute your project's JavaScript.
- All traffic is encrypted in transit with TLS.

No system is perfectly secure. If we become aware of a breach affecting your personal data, we will notify you and the relevant supervisory authorities as the law requires.

## 13\. Children

Jx Suite is not directed to children. We do not knowingly collect personal data from anyone under 16, and using the Publishing Platform requires a GitHub account, which GitHub restricts by age. If you believe a child has provided us personal data, write to [privacy@jxsuite.com](mailto:privacy@jxsuite.com) and we will delete it.

## 14\. Your rights in the EEA, the UK, and Switzerland

If the GDPR or UK GDPR applies to you, you have the right to:

- **Access** the personal data we hold about you, and receive a copy (Article 15)
- **Rectify** data that is inaccurate or incomplete (Article 16)
- **Erase** your data (Article 17)
- **Restrict** processing in certain circumstances (Article 18)
- **Portability** — receive your data in a structured, machine-readable format, or have it transmitted to another controller (Article 20)
- **Object** to processing based on legitimate interests, including on grounds relating to your particular situation (Article 21)
- **Withdraw consent** at any time, where processing rests on consent, without affecting processing already carried out
- **Complain** to your supervisory authority. In the UK that is the Information Commissioner's Office (ico.org.uk); in the EEA it is the authority for your country of residence.

Much of this you can do yourself and immediately: your project content lives in your own GitHub repositories, you can revoke our GitHub App and disconnect Cloudflare from within your own accounts, and signing out destroys your session record.

For anything else, write to [privacy@jxsuite.com](mailto:privacy@jxsuite.com). We respond within one month, extendable by two further months for complex requests, and we will tell you if we need the extension. We verify requests through the GitHub account they concern. We do not charge for these requests and we will not treat you differently for making one.

## 15\. Your California rights

If you are a California resident, the CCPA as amended by the CPRA gives you the rights below.

**What we collect, in CCPA categories.** In the last 12 months we have collected: _identifiers_ (GitHub user id, login, display name, avatar URL, IP address in server logs); _internet or network activity_ (request metadata and audit records for the Publishing Platform); and _other information you provide_ (the content of project files you choose to edit with the hosted service). We do not collect sensitive personal information for the purpose of inferring characteristics, and we do not collect biometric, geolocation, health, or financial account data.

**Sources, purposes, and disclosures.** We collect this from you and from GitHub when you sign in. We use it for the purposes described in sections 4 to 6. We disclose it for business purposes to the service providers in section 8.

**We do not sell or share.** Avunu has not sold personal information, and has not shared it for cross-context behavioural advertising, in the preceding 12 months, and we do not do so now. We do not use or disclose sensitive personal information beyond the purposes permitted under § 7027(m) of the CCPA regulations, so the right to limit its use does not arise.

**Your rights:** to know what we collect and how we use it; to access a copy; to correct inaccurate information; to delete your personal information; to opt out of sale or sharing (not applicable, as above); to limit the use of sensitive personal information (not applicable, as above); and to be free from discrimination for exercising any of them.

To exercise a right, write to [privacy@jxsuite.com](mailto:privacy@jxsuite.com). We verify your identity through the GitHub account the request concerns. You may use an authorised agent; we will ask for written proof of their authority.

## 16\. Other United States privacy laws

Residents of Colorado, Connecticut, Virginia, Utah, Texas, Oregon, Montana, and other states with comprehensive privacy statutes have comparable rights of access, correction, deletion, and portability, together with the right to opt out of targeted advertising, sale, and profiling that produces legal or similarly significant effects. We conduct none of those three activities. Use the same contact address, and where your state provides an appeal process for a refused request, we will tell you how to use it.

## 17\. Automated decision-making

We do not carry out automated decision-making that produces legal or similarly significant effects about you. The AI features in Jx Suite generate and edit website content at your request; they make no decisions about you.

## 18\. Changes to this policy

We will update this policy when Jx Suite changes. When a change materially affects how we handle your personal data, we will revise the effective date at the top, note what changed, and — for Publishing Platform users — give notice in the application before the change takes effect. The current version always lives at jxsuite.com/privacy.

## 19\. Contact us

**Avunu LLC** 948 E Philadelphia St, York Pennsylvania 17403, United States

**Privacy enquiries and rights requests:** [privacy@jxsuite.com](mailto:privacy@jxsuite.com)

This policy is governed by the laws of the Commonwealth of Pennsylvania, without regard to its conflict-of-laws rules, except where the law of your own residence grants you rights that cannot be waived by contract, which continue to apply.

::: ::::
