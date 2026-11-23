using System;

namespace Formfeed.Internal;

internal static class Guard
{
    /// <summary>The value, or <see cref="ArgumentNullException"/> for a null one.</summary>
    public static T NotNull<T>(T? value, string name)
        where T : class =>
        value ?? throw new ArgumentNullException(name);
}
