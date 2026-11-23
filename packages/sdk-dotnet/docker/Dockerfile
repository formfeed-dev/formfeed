# The .NET SDK's checks (plan 34): the official .NET SDK image of the version asked for, with the
# .NET 8 and .NET 10 runtimes beside its own, so the tests run on net10.0 and on net8.0, which takes
# the library's netstandard2.0 build, whichever SDK builds them. Built by scripts/dotnet.mjs, which
# mounts the repository.
ARG DOTNET=10.0
FROM mcr.microsoft.com/dotnet/runtime:8.0 AS runtime8
FROM mcr.microsoft.com/dotnet/runtime:10.0 AS runtime10
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET}
COPY --from=runtime8 /usr/share/dotnet/shared/Microsoft.NETCore.App /usr/share/dotnet/shared/Microsoft.NETCore.App
COPY --from=runtime10 /usr/share/dotnet/shared/Microsoft.NETCore.App /usr/share/dotnet/shared/Microsoft.NETCore.App
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
  DOTNET_NOLOGO=1 \
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
  DOTNET_GENERATE_ASPNET_CERTIFICATE=false \
  NUGET_PACKAGES=/nuget/packages \
  MSBUILDDISABLENODEREUSE=1
