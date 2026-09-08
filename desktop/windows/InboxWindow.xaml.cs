using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Diagnostics;
using System.IO;
using Forms = System.Windows.Forms;
using WpfDataFormats = System.Windows.DataFormats;
using WpfDataObject = System.Windows.DataObject;
using WpfDragDropEffects = System.Windows.DragDropEffects;
using WpfMessageBox = System.Windows.MessageBox;
using WpfMouseEventArgs = System.Windows.Input.MouseEventArgs;
using WpfPoint = System.Windows.Point;

namespace XingqiaoDesktop;

public partial class InboxWindow : Window
{
    private readonly TempInboxStore _store;
    private WpfPoint _dragStart;
    private bool _allowClose;

    public InboxWindow(TempInboxStore store)
    {
        _store = store;
        InitializeComponent();
        DataContext = store;
        _store.Changed += Refresh;
        Refresh();
    }

    public void ShowInbox()
    {
        Refresh();
        if (!IsVisible) Show();
        Activate();
        Topmost = true;
    }

    public void CloseForApplication()
    {
        _allowClose = true;
        Close();
    }

    private void Refresh()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.Invoke(Refresh); return; }
        EmptyText.Visibility = _store.Files.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        var selectedCount = SelectedFiles().Count;
        var hasSelection = selectedCount > 0;
        SelectionText.Text = hasSelection ? $"已选中 {selectedCount} 项" : "未选中文件";
        SelectAllButton.IsEnabled = _store.Files.Count > 0;
        SelectAllButton.Content = selectedCount == _store.Files.Count && _store.Files.Count > 0 ? "取消全选" : "全选";
        PreviewButton.IsEnabled = hasSelection;
        SaveButton.IsEnabled = hasSelection;
        RemoveButton.IsEnabled = hasSelection;
    }

    private void FilesList_SelectionChanged(object sender, SelectionChangedEventArgs e) => Refresh();

    private void FilesList_PreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        _dragStart = e.GetPosition(null);
    }

    private void FilesList_PreviewMouseMove(object sender, WpfMouseEventArgs e)
    {
        var files = SelectedFiles();
        if (e.LeftButton != MouseButtonState.Pressed || files.Count == 0) return;
        var current = e.GetPosition(null);
        if (Math.Abs(current.X - _dragStart.X) < SystemParameters.MinimumHorizontalDragDistance &&
            Math.Abs(current.Y - _dragStart.Y) < SystemParameters.MinimumVerticalDragDistance) return;
        var paths = files.Select(file => file.Path).Where(File.Exists).ToArray();
        if (paths.Length == 0) return;
        var data = new WpfDataObject(WpfDataFormats.FileDrop, paths);
        DragDrop.DoDragDrop(FilesList, data, WpfDragDropEffects.Copy);
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        var files = SelectedFiles();
        if (files.Count == 0) return;
        using var picker = new Forms.FolderBrowserDialog { Description = "选择星桥文件的保存位置", UseDescriptionForTitle = true };
        if (picker.ShowDialog() != Forms.DialogResult.OK) return;
        var failures = new List<string>();
        foreach (var file in files)
        {
            try { _store.Save(file, picker.SelectedPath); }
            catch (Exception error) { failures.Add($"{file.Name}：{error.Message}"); }
        }
        if (failures.Count == 0)
            WpfMessageBox.Show($"已保存 {files.Count} 个选中文件到：{picker.SelectedPath}", "星桥", MessageBoxButton.OK, MessageBoxImage.Information);
        else
            WpfMessageBox.Show($"部分文件未能保存：\n{string.Join("\n", failures)}", "星桥", MessageBoxButton.OK, MessageBoxImage.Error);
    }

    private void Remove_Click(object sender, RoutedEventArgs e)
    {
        foreach (var file in SelectedFiles()) _store.Discard(file);
    }

    private void SelectAll_Click(object sender, RoutedEventArgs e)
    {
        if (FilesList.SelectedItems.Count == _store.Files.Count) FilesList.UnselectAll();
        else FilesList.SelectAll();
    }

    private void Preview_Click(object sender, RoutedEventArgs e) => PreviewSelected();

    private void FilesList_MouseDoubleClick(object sender, MouseButtonEventArgs e) => PreviewSelected();

    private void PreviewSelected()
    {
        var file = SelectedFiles().FirstOrDefault();
        if (file is null || !File.Exists(file.Path)) return;
        try { Process.Start(new ProcessStartInfo(file.Path) { UseShellExecute = true }); }
        catch (Exception error) { WpfMessageBox.Show($"无法预览文件：{error.Message}", "星桥", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private List<TransferFile> SelectedFiles() => FilesList.SelectedItems.OfType<TransferFile>().ToList();

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (!_allowClose)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }
}
