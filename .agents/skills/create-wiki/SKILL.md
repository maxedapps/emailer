---
name: create-wiki
description: Describes in detail how to research information and then create a knowledge base / wiki based on that research. Covering various topics in-depth, focusing on the key pain points and best practices that matter for day to day work with those researched topics Use this skill when asked to create or update a knowledge base or wiki.
---

A wiki (or knowledge base) in this context is a collection of markdown documents (organized into per-topic subfolders) that contain researched information on specific topics. 
Think of it as an "offline version" of online documention - though curated and with a focus on the points that are easy to get wrong.

# Research Process

For researching a topic, there are two key rules:
- be comprehensive and thorough => Dive DEEP into the available (web) resources (like official docs, blog posts, changelogs etc)
- critically analyze information and identify the key pain points, best practices (and also antipatterns / pitfalls)

The goal is NOT to copy documentation or information word for word. Instead, the goal is to synthesize the information into a concise and clear format that is easy to read and understand. We want to build a knowledge base that provides actionable, useful information for humans and, most importantly, AI agents.

When researching, consider the following steps:
1. Identify the topic and its scope: Clearly define what the topic is about and what aspects you want to cover.
2. Gather information: Use reliable sources such as official documentation, reputable blogs, and community forums
3. Analyze and synthesize: Critically evaluate the information you have gathered, identify key pain points, best practices, and common pitfalls. Synthesize this information into a clear and concise format.
When in doubt: Ask the user if a topic matters and if something really is a pain point. Don't discard information easily. But also don't store everything "just to be safe". Curation is a key and critical step in this process!

# Wiki Structure

Each topic gets its own folder in a project-root "wiki" folder. So `wiki/<topic-name>/` is the root folder for a topic. 
Inside that topic folder, we have one `.md` file per "topic area". Something like `wiki/effect/best-practices.md` or `wiki/effect/queues-and-jobs.md`. 

In that `.md` file, we want a concise, actionable, and clear description of the topic area, the key takeaways, example code snippets, and links to relevant resources. Whilst links definitely must be provided, the goal is to have enough information in the `.md` file itself so that an agent can understand the topic area and apply the knowledge (to write good code!) without necessarily looking up the source.

DO NOT create an index or `README.md` file - instead choose `.md` filenames that clearly describe the content and therefore make it easy for agents to find the right information. 

# Rules

- The wiki is **NEVER** a documentation for the project it's in. It's **NEVER** about specs, decisions, or project architecture. It is **ONLY** an in-depth knowledge base for the key technologies, libraries etc used in a project.
- All `.md` files therefore must NOT reference the project or have project-specific information! Copying the wiki into another project should not require any changes to the content of the `.md` files.