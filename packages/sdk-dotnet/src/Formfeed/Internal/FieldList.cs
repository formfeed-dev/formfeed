using System.Collections;
using System.Collections.Generic;

namespace Formfeed.Internal;

/// <summary>
/// The fields of a request in the order they are sent, as JSON members or as multipart fields. A
/// field set again keeps its place and takes the new value, as PHP's array spread does, so a
/// request's <c>AdditionalFields</c> replace a named field of the same name.
/// </summary>
internal sealed class FieldList : IEnumerable<KeyValuePair<string, object?>>
{
    private readonly List<KeyValuePair<string, object?>> items = [];

    public int Count => items.Count;

    /// <summary>Adds the field when it has a value; a field without one is left out.</summary>
    public FieldList Add(string name, object? value) => value is null ? this : Set(name, value);

    /// <summary>Sets the field, null included, which JSON sends as <c>null</c>.</summary>
    public FieldList Set(string name, object? value)
    {
        for (var i = 0; i < items.Count; i++)
        {
            if (items[i].Key == name)
            {
                items[i] = new KeyValuePair<string, object?>(name, value);
                return this;
            }
        }
        items.Add(new KeyValuePair<string, object?>(name, value));
        return this;
    }

    /// <summary>Sets every entry, nulls included.</summary>
    public FieldList SetAll(IEnumerable<KeyValuePair<string, object?>>? fields)
    {
        if (fields is null)
        {
            return this;
        }
        foreach (var field in fields)
        {
            Set(field.Key, field.Value);
        }
        return this;
    }

    public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => items.GetEnumerator();

    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}
