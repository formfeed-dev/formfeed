import nx from "@nx/eslint-plugin";

export default [
    ...nx.configs["flat/base"],
    ...nx.configs["flat/typescript"],
    ...nx.configs["flat/javascript"],
    {
      "ignores": [
        "**/dist",
        "**/out-tsc",
        "**/.astro",
        "**/.docusaurus",
        "**/build",
        "**/.wrangler",
        "**/.angular",
        "**/vitest.config.*.timestamp*",
        // Python virtual environments (tools/video/voice-server): site-packages ships JavaScript too
        "**/.venv*"
      ]
    },
    {
        files: [
            "**/*.ts",
            "**/*.tsx",
            "**/*.js",
            "**/*.jsx"
        ],
        rules: {
            "@nx/enforce-module-boundaries": [
                "error",
                {
                    enforceBuildableLibDependency: true,
                    allow: [
                        "^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$",
                        // The two media manifests (plan 13 §2) are generated data, not a project's
                        // code: one file each, read by both sites, so a video or a clip is never
                        // live on one site and missing from the other. They sit beside the tools
                        // that write them, so importing one crosses a project boundary without
                        // depending on anything in that project.
                        "^.*/tools/video/published\\.json$",
                        "^.*/tools/app-recording/recorded\\.json$"
                    ],
                    depConstraints: [
                        {
                            sourceTag: "*",
                            onlyDependOnLibsWithTags: [
                                "*"
                            ]
                        }
                    ]
                }
            ]
        }
    },
    {
        files: [
            "**/*.ts",
            "**/*.tsx",
            "**/*.cts",
            "**/*.mts",
            "**/*.js",
            "**/*.jsx",
            "**/*.cjs",
            "**/*.mjs"
        ],
        // Override or add rules here
        rules: {}
    }
];
