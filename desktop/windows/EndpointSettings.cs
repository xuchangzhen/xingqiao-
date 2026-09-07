using System.Text.Json;

namespace XingqiaoDesktop;

public static class EndpointSettings
{
    private sealed record Values(string? Endpoint);
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Xingqiao", "settings.json"
    );

    public static string? Load()
    {
        try { return JsonSerializer.Deserialize<Values>(File.ReadAllText(FilePath))?.Endpoint; }
        catch (IOException) { return null; }
        catch (JsonException) { return null; }
    }

    public static void Save(Uri endpoint)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(new Values(endpoint.AbsoluteUri)));
    }
}
