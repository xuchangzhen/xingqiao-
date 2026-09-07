namespace XingqiaoDesktop;

public sealed record TransferFile(Guid Id, string Name, string Mime, string Path, DateTimeOffset CreatedAt);
