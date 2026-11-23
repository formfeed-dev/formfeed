using System.Collections.Generic;
using Formfeed.Internal;

namespace Formfeed;

/// <summary>
/// What every PDF tool takes beside its own options: the output's name, how long it is kept, how it
/// is linked. What is left null is not sent.
/// </summary>
public abstract class PdfToolOptions
{
    /// <summary>The name of the output file.</summary>
    public string? Filename { get; set; }

    /// <summary>Seconds until the output expires; it shortens the retention and cannot lengthen it.</summary>
    public int? ExpiresIn { get; set; }

    /// <summary><c>signed</c> or <c>public</c>; the workspace's setting when null.</summary>
    public string? Access { get; set; }

    /// <summary>Your own data, returned with the render.</summary>
    public IDictionary<string, object?>? Meta { get; set; }

    /// <summary>The copy to the workspace's own bucket: <c>false</c>, or a map with its <c>key</c>.</summary>
    public object? Storage { get; set; }

    /// <summary>Fields this SDK does not name, sent as given (a null as JSON <c>null</c>); one of a named field's name replaces it.</summary>
    public IDictionary<string, object?>? AdditionalFields { get; set; }

    internal FieldList ToFields()
    {
        var fields = new FieldList();
        AddOwn(fields);
        return fields
            .Add("filename", Filename)
            .Add("expires_in", ExpiresIn)
            .Add("access", Access)
            .Add("meta", Meta)
            .Add("storage", Storage)
            .SetAll(AdditionalFields);
    }

    /// <summary>Adds the tool's own fields, first.</summary>
    private protected virtual void AddOwn(FieldList fields)
    {
    }
}

/// <summary>Options of <see cref="PdfService.MergeAsync"/>.</summary>
public sealed class MergeOptions : PdfToolOptions
{
}

/// <summary>Options of <see cref="PdfService.CompressAsync"/>.</summary>
public sealed class CompressOptions : PdfToolOptions
{
}

/// <summary>Options of <see cref="PdfService.ProtectAsync"/>: AES-256 with at least one password.</summary>
public sealed class ProtectOptions : PdfToolOptions
{
    /// <summary>The password that opens the document.</summary>
    public string? UserPassword { get; set; }

    /// <summary>The password that lifts the restrictions; a random one nobody knows when null.</summary>
    public string? OwnerPassword { get; set; }

    /// <summary>What a reader without the owner password may do: <c>print</c>, <c>copy</c>, <c>modify</c>, <c>annotate</c>; all four when null, none for an empty list.</summary>
    public IList<string>? Permissions { get; set; }

    private protected override void AddOwn(FieldList fields) => fields
        .Add("user_password", UserPassword)
        .Add("owner_password", OwnerPassword)
        .Add("permissions", Permissions);
}

/// <summary>Options of <see cref="PdfService.WatermarkAsync"/>: a text or a library image, not both.</summary>
public sealed class WatermarkOptions : PdfToolOptions
{
    /// <summary>The text, 1 to 200 characters of Latin, Greek or Cyrillic script.</summary>
    public string? Text { get; set; }

    /// <summary>A PNG or JPEG of the library, by name or file id.</summary>
    public string? Image { get; set; }

    /// <summary>From 0 (invisible) to 1 (opaque); 0.2 by default.</summary>
    public double? Opacity { get; set; }

    /// <summary>Degrees clockwise as in CSS; a text runs diagonally and an image stands upright by default.</summary>
    public double? Rotation { get; set; }

    /// <summary>The text's colour as hex, such as <c>#737380</c>.</summary>
    public string? Color { get; set; }

    private protected override void AddOwn(FieldList fields) => fields
        .Add("text", Text)
        .Add("image", Image)
        .Add("opacity", Opacity)
        .Add("rotation", Rotation)
        .Add("color", Color);
}

/// <summary>Options of <see cref="PdfService.SplitAsync"/>: <see cref="Every"/> or <see cref="Ranges"/>.</summary>
public sealed class SplitOptions : PdfToolOptions
{
    /// <summary>Pages per part.</summary>
    public int? Every { get; set; }

    /// <summary>One part per entry, such as <c>1-3</c> or <c>4-</c>.</summary>
    public IList<string>? Ranges { get; set; }

    private protected override void AddOwn(FieldList fields) => fields
        .Add("every", Every)
        .Add("ranges", Ranges);
}

/// <summary>Options of <see cref="PdfService.ToImageAsync"/>.</summary>
public sealed class ToImageOptions : PdfToolOptions
{
    /// <summary>The pages to draw, such as <c>1</c>, <c>1-3,5</c> or <c>2-</c>; every page when null.</summary>
    public string? Pages { get; set; }

    /// <summary><c>png</c> or <c>jpg</c>.</summary>
    public string? Format { get; set; }

    /// <summary>The resolution, 36 to 300; 150 by default.</summary>
    public int? Dpi { get; set; }

    /// <summary>The quality of a JPEG, 1 to 100.</summary>
    public int? Quality { get; set; }

    private protected override void AddOwn(FieldList fields) => fields
        .Add("pages", Pages)
        .Add("format", Format)
        .Add("dpi", Dpi)
        .Add("quality", Quality);
}

/// <summary>A rectangle to remove, as a viewer shows the page, in points from its top left corner.</summary>
public sealed class RedactRegion
{
    /// <summary>The page, from 1.</summary>
    public int Page { get; set; }

    /// <summary>The distance from the page's left edge.</summary>
    public double X { get; set; }

    /// <summary>The distance from the page's top edge.</summary>
    public double Y { get; set; }

    /// <summary>The width.</summary>
    public double Width { get; set; }

    /// <summary>The height.</summary>
    public double Height { get; set; }

    internal FieldList ToFields() => new FieldList()
        .Set("page", Page)
        .Set("x", X)
        .Set("y", Y)
        .Set("width", Width)
        .Set("height", Height);
}

/// <summary>Options of <see cref="PdfService.RedactAsync"/>: the rectangles and the texts to remove.</summary>
public sealed class RedactOptions : PdfToolOptions
{
    /// <summary>The rectangles to remove.</summary>
    public IList<RedactRegion>? Regions { get; set; }

    /// <summary>Texts to remove wherever they stand, each as it reads; never stored.</summary>
    public IList<string>? Text { get; set; }

    /// <summary>Finds a text only in the case it is written in.</summary>
    public bool? MatchCase { get; set; }

    /// <summary>Finds a text only where a word boundary stands on each side of it.</summary>
    public bool? WholeWords { get; set; }

    /// <summary>The colour of the box drawn over what was removed, such as <c>#000000</c> (the API's default).</summary>
    public string? Fill { get; set; }

    /// <summary>Draws no box: sends <c>fill: null</c>.</summary>
    public bool NoFill { get; set; }

    private protected override void AddOwn(FieldList fields)
    {
        List<FieldList>? regions = null;
        if (Regions is not null)
        {
            regions = [];
            foreach (var region in Regions)
            {
                regions.Add((region ?? new RedactRegion()).ToFields());
            }
        }
        fields
            .Add("regions", regions)
            .Add("text", Text)
            .Add("match_case", MatchCase)
            .Add("whole_words", WholeWords);
        if (NoFill)
        {
            fields.Set("fill", null);
        }
        else
        {
            fields.Add("fill", Fill);
        }
    }
}

/// <summary>Options of <see cref="PdfService.FillAsync"/>: the values by the fields' full names.</summary>
public sealed class FillOptions : PdfToolOptions
{
    /// <summary>The values by field name, as <see cref="PdfService.GetInfoAsync"/> lists them: text, a boolean for a check box, an option's value.</summary>
    public IDictionary<string, object?>? Fields { get; set; }

    /// <summary>Draws the values into the pages instead of keeping the form fillable.</summary>
    public bool? Flatten { get; set; }

    /// <summary><c>false</c> leaves out a name the form lacks and a value its field does not take, and lists them, where the API's default fails the render.</summary>
    public bool? Strict { get; set; }

    private protected override void AddOwn(FieldList fields) => fields
        .Add("fields", Fields)
        .Add("flatten", Flatten)
        .Add("strict", Strict);
}

/// <summary>Options of <see cref="PdfService.ConvertAsync"/>.</summary>
public sealed class ConvertOptions : PdfToolOptions
{
    /// <summary>The pages to convert, such as <c>1-3</c>.</summary>
    public string? PageRanges { get; set; }

    /// <summary>Lays the pages out in landscape.</summary>
    public bool? Landscape { get; set; }

    /// <summary>Puts every sheet of a spreadsheet on one page.</summary>
    public bool? SinglePageSheets { get; set; }

    private protected override void AddOwn(FieldList fields) => fields
        .Add("page_ranges", PageRanges)
        .Add("landscape", Landscape)
        .Add("single_page_sheets", SinglePageSheets);
}
