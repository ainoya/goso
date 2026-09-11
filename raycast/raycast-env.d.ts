/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** goso CLI path - Path to the goso executable. Raycast's Node cannot read Antigravity's SQLite databases, so the extension calls the CLI when it is available. Leave empty to search ~/.local/bin, /opt/homebrew/bin and /usr/local/bin. */
  "cliPath"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `usage` command */
  export type Usage = ExtensionPreferences & {}
  /** Preferences accessible in the `menubar` command */
  export type Menubar = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `usage` command */
  export type Usage = {}
  /** Arguments passed to the `menubar` command */
  export type Menubar = {}
}

