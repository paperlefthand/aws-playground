#!/usr/bin/env node
/**
 * CDK アプリのエントリポイント(cdk.json の `app` から実行される)。
 *
 * 実体は lib/lab-app.ts にある。テストからも同じ組み立てを使うことで、
 * 「テストは通るが cdk synth が落ちる」状態を作らないようにしている。
 *
 * `cdk deploy` は実行しないこと(デプロイ手順は README.md 参照)。
 */

import { createLabApp } from "../lib/lab-app.ts";

createLabApp();
