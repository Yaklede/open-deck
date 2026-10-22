#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_javac="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
task_java="${JAVA_HOME:+$JAVA_HOME/bin/}java"
task_classes="$(mktemp -d)"
trap 'rm -rf "$task_classes"' EXIT
"$task_javac" -d "$task_classes" android/app/src/main/java/app/opendeck/client/SwipePhysics.java android/app/src/main/java/app/opendeck/client/DataFreshness.java test/android/SwipePhysicsTest.java test/android/DataFreshnessTest.java
"$task_java" -cp "$task_classes" app.opendeck.client.SwipePhysicsTest

"$task_java" -cp "$task_classes" app.opendeck.client.DataFreshnessTest
