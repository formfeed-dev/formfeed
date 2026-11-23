# The Java SDK's checks (plan 34): the official Maven image of the Java version asked for. Built by
# scripts/java.mjs, which mounts the repository and keeps Maven's repository in a volume.
ARG JAVA=11
FROM maven:3-eclipse-temurin-${JAVA}
ENV MAVEN_ARGS="--batch-mode --no-transfer-progress"
